import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { cloudConfigured, cloudDestroy, cloudUpload } from "./cloudinary.js";
import { CHUNK, decryptChunk, deriveKey, encryptChunk } from "./backupCrypto.js";

// Respaldo en Cloudinary: los archivos locales se cortan en bloques de 8 MiB, se cifran con AES-256-GCM
// (clave derivada de BACKUP_KEY) y se suben. Si el disco del servidor se borra, se restauran al vuelo.
export const backupEnabled = () => cloudConfigured() && config.backupKey.length >= 16;
export const backupStatus = { pending: 0, lastError: "" };

let keyCache: Buffer | null = null;
const key = () => (keyCache ??= deriveKey(config.backupKey));

export function relOf(abs: string): string {
  const r = relative(resolve(config.storageDir), resolve(abs));
  if (!r || r.startsWith("..") || isAbsolute(r)) throw new Error("Ruta fuera del almacenamiento.");
  return r.split(sep).join("/");
}
function absOf(rel: string): string {
  const base = resolve(config.storageDir);
  const f = resolve(base, rel);
  if (!f.startsWith(base + sep)) throw new Error("Ruta inválida.");
  return f;
}
async function sha256Of(file: string) {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest("hex");
}

export async function backupFile(rel: string): Promise<void> {
  const abs = absOf(rel);
  const st = await stat(abs);
  const sha = await sha256Of(abs);
  const { rows } = await pool.query(`SELECT sha256, public_ids FROM backup_files WHERE rel_path=$1`, [rel]);
  if (rows[0]?.sha256 === sha) return; // ya está respaldado igual
  const urls: string[] = [], ids: string[] = [];
  const fh = await open(abs, "r");
  try {
    const stamp = Date.now().toString(36);
    const dir = createHash("sha256").update(rel).digest("hex").slice(0, 24);
    for (let i = 0, pos = 0; ; i++) {
      const len = Math.min(CHUNK, st.size - pos);
      const buf = Buffer.alloc(len);
      if (len) await fh.read(buf, 0, len, pos);
      pos += len;
      const pid = `${dir}/${stamp}_${i}`;
      const up = await cloudUpload(pid, encryptChunk(buf, key()));
      urls.push(up.url);
      ids.push(up.publicId);
      if (pos >= st.size) break;
    }
  } finally { await fh.close(); }
  await pool.query(
    `INSERT INTO backup_files (rel_path, parts, size_bytes, sha256, urls, public_ids)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     ON CONFLICT (rel_path) DO UPDATE SET parts=EXCLUDED.parts, size_bytes=EXCLUDED.size_bytes, sha256=EXCLUDED.sha256,
       urls=EXCLUDED.urls, public_ids=EXCLUDED.public_ids, updated_at=now()`,
    [rel, ids.length, st.size, sha, JSON.stringify(urls), JSON.stringify(ids)]);
  for (const old of (rows[0]?.public_ids ?? []) as string[]) await cloudDestroy(old).catch(() => {}); // versión anterior
}

export async function restoreFile(rel: string): Promise<boolean> {
  if (!backupEnabled()) return false;
  const { rows } = await pool.query(`SELECT size_bytes, sha256, urls FROM backup_files WHERE rel_path=$1`, [rel]);
  const r = rows[0];
  if (!r) return false;
  const abs = absOf(rel), tmp = abs + ".restore";
  await mkdir(dirname(abs), { recursive: true });
  const out = await open(tmp, "w");
  const h = createHash("sha256");
  let size = 0;
  try {
    for (const url of r.urls as string[]) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Descarga de respaldo falló (${res.status})`);
      const plain = decryptChunk(Buffer.from(await res.arrayBuffer()), key());
      h.update(plain); size += plain.length;
      await out.write(plain);
    }
  } catch (e) { await out.close().catch(() => {}); await rm(tmp, { force: true }); throw e; }
  await out.close();
  if (h.digest("hex") !== r.sha256 || size !== Number(r.size_bytes)) {
    await rm(tmp, { force: true });
    throw new Error("El respaldo está dañado o no coincide.");
  }
  await rename(tmp, abs);
  return true;
}

// Garantiza que el archivo esté en el disco: si falta, lo restaura desde Cloudinary.
const inflight = new Map<string, Promise<boolean>>();
export async function ensureLocalFile(abs: string): Promise<boolean> {
  try { await stat(abs); return true; } catch { /* falta */ }
  if (!backupEnabled()) return false;
  let rel: string;
  try { rel = relOf(abs); } catch { return false; }
  let p = inflight.get(rel);
  if (!p) {
    p = restoreFile(rel).catch((e) => { backupStatus.lastError = "Restaurar: " + String(e?.message ?? e).slice(0, 160); return false; })
      .finally(() => inflight.delete(rel));
    inflight.set(rel, p);
  }
  return p;
}

// Subidas en segundo plano, una a la vez, con 3 intentos.
let chain: Promise<void> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function scheduleBackup(abs: string) {
  if (!backupEnabled()) return;
  let rel: string;
  try { rel = relOf(abs); } catch { return; }
  backupStatus.pending++;
  const job = chain.then(async () => {
    for (let a = 1; a <= 3; a++) {
      try { await backupFile(rel); backupStatus.lastError = ""; return; }
      catch (e: any) { backupStatus.lastError = "Respaldar: " + String(e?.message ?? e).slice(0, 160); if (a < 3) await sleep(2000 * a); }
    }
  });
  chain = job.catch(() => {}).finally(() => { backupStatus.pending--; });
}

async function dropRows(rows: { public_ids: string[] }[]) {
  for (const r of rows) for (const pid of r.public_ids) await cloudDestroy(pid).catch(() => {});
}
export async function dropBackup(abs: string) {
  let rel: string;
  try { rel = relOf(abs); } catch { return; }
  const { rows } = await pool.query(`DELETE FROM backup_files WHERE rel_path=$1 RETURNING public_ids`, [rel]);
  if (backupEnabled()) await dropRows(rows);
}
export async function dropBackupPrefix(relPrefix: string) {
  const { rows } = await pool.query(`DELETE FROM backup_files WHERE starts_with(rel_path, $1) RETURNING public_ids`, [relPrefix]);
  if (backupEnabled()) await dropRows(rows);
        }
