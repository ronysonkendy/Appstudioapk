import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pool } from "../db/pool.js";
import { projectDir } from "../storage/local.js";
import { decodeApk } from "./apktool.js";
import { dropBackup, dropBackupPrefix, relOf, restoreFile, scheduleBackup } from "./backup.js";

export const decodedDir = (id: string) => join(projectDir(id), "decoded");
const origDir = (id: string) => join(projectDir(id), "decoded_orig");
export const MAX_DECODED = 1024 * 1024;

// Solo se editan: manifiesto, apktool.yml y los XML de res/<carpeta>/<archivo>.xml
export function isEditablePath(rel: unknown): rel is string {
  if (typeof rel !== "string" || !rel || rel.length > 400) return false;
  if (rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || rel.split("/").includes("..")) return false;
  if (rel === "AndroidManifest.xml" || rel === "apktool.yml") return true;
  return /^res\/[^/]+\/[^/]+\.xml$/.test(rel);
}

function full(base: string, rel: string) {
  const b = resolve(base);
  const f = resolve(b, rel);
  if (!f.startsWith(b + sep)) throw new Error("Ruta inválida.");
  return f;
}

export async function listDecoded(id: string): Promise<{ path: string; size: number }[]> {
  const base = decodedDir(id);
  const out: { path: string; size: number }[] = [];
  const add = async (rel: string) => {
    try { const s = await stat(join(base, rel)); if (s.isFile()) out.push({ path: rel, size: s.size }); } catch { /* no existe */ }
  };
  await add("AndroidManifest.xml");
  await add("apktool.yml");
  let dirs: string[] = [];
  try { dirs = await readdir(join(base, "res")); } catch { return out; }
  for (const d of dirs.sort()) {
    let files: string[] = [];
    try { files = await readdir(join(base, "res", d)); } catch { continue; }
    for (const f of files.sort()) if (f.endsWith(".xml") && out.length < 5000) await add(`res/${d}/${f}`);
  }
  return out;
}

export async function readDecoded(id: string, rel: string, original = false): Promise<string> {
  if (original) {
    try { return await readFile(full(origDir(id), rel), "utf8"); } catch { /* sin copia: no fue editado */ }
  }
  return readFile(full(decodedDir(id), rel), "utf8");
}

export async function editedPaths(id: string): Promise<Set<string>> {
  const { rows } = await pool.query(`SELECT path FROM decode_edits WHERE project_id=$1`, [id]);
  return new Set(rows.map((r) => r.path as string));
}

// Copia al escribir: antes de la primera edición se guarda el original para poder restaurarlo.
export async function writeDecoded(id: string, rel: string, content: string): Promise<boolean> {
  const cur = full(decodedDir(id), rel), orig = full(origDir(id), rel);
  let hasOrig = true;
  try { await stat(orig); } catch { hasOrig = false; }
  if (!hasOrig) { await mkdir(dirname(orig), { recursive: true }); await copyFile(cur, orig); }
  await writeFile(cur, content, "utf8");
  scheduleBackup(cur); // las ediciones se respaldan: el APK decodificado se puede rehacer, tus cambios no
  if ((await readFile(orig, "utf8")) === content) { await restoreDecoded(id, rel); return false; }
  await pool.query(
    `INSERT INTO decode_edits (project_id, path) VALUES ($1,$2)
     ON CONFLICT (project_id, path) DO UPDATE SET updated_at=now()`, [id, rel]);
  await pool.query(`UPDATE projects SET status='modified', updated_at=now() WHERE id=$1`, [id]);
  return true;
}

export async function restoreDecoded(id: string, rel: string): Promise<boolean> {
  const cur = full(decodedDir(id), rel), orig = full(origDir(id), rel);
  let had = false;
  try { await stat(orig); await copyFile(orig, cur); await rm(orig, { force: true }); had = true; } catch { /* sin copia */ }
  await dropBackup(cur);
  const r = await pool.query(`DELETE FROM decode_edits WHERE project_id=$1 AND path=$2`, [id, rel]);
  return had || (r.rowCount ?? 0) > 0;
}

export async function restoreAllDecoded(id: string) {
  for (const p of await editedPaths(id)) await restoreDecoded(id, p);
}

export async function hasDecodedDir(id: string): Promise<boolean> {
  try { return (await stat(decodedDir(id))).isDirectory(); } catch { return false; }
}

// Si el disco se borró: se vuelve a decodificar y se reaplican las ediciones desde el respaldo.
export async function rehydrateDecoded(id: string, originalPath: string): Promise<void> {
  await decodeApk(originalPath, decodedDir(id));
  await rm(origDir(id), { recursive: true, force: true });
  for (const rel of await editedPaths(id)) {
    const cur = full(decodedDir(id), rel), orig = full(origDir(id), rel);
    let ok = false;
    try {
      await mkdir(dirname(orig), { recursive: true });
      await copyFile(cur, orig);
      ok = await restoreFile(relOf(cur));
    } catch { ok = false; }
    if (!ok) await pool.query(`DELETE FROM decode_edits WHERE project_id=$1 AND path=$2`, [id, rel]); // sin respaldo no se puede recuperar
  }
}

export async function resetDecoded(id: string) {
  await dropBackupPrefix(`projects/${id}/decoded/`);
  await rm(decodedDir(id), { recursive: true, force: true });
  await rm(origDir(id), { recursive: true, force: true });
  await pool.query(`DELETE FROM decode_edits WHERE project_id=$1`, [id]);
}
