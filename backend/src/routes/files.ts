import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../db/pool.js";
import { projectDir } from "../storage/local.js";
import { listZip, readZipEntry } from "../services/zipSafe.js";
import { classify, ext, sniffImage, IMG_MIME, IMG_TYPE } from "../services/editable.js";

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMG = 5 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/;

function bad(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

async function getProject(id: string, uid: string) {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(`SELECT * FROM projects WHERE id=$1 AND owner_id=$2`, [id, uid]);
  return rows[0] ?? null;
}

// Solo se aceptan rutas que existan realmente dentro del APK (nunca rutas del sistema de archivos).
async function findEntry(p: any, path: unknown) {
  if (typeof path !== "string" || path.length === 0 || path.length > 500) return null;
  const entries = await listZip(p.original_path);
  const e = entries.find((x) => x.path === path && !x.isDir);
  return e ? { path, size: e.size } : null;
}

const storedPath = (id: string, stored: string) => join(projectDir(id), "changes", stored);

async function getChange(id: string, path: string) {
  const { rows } = await pool.query(`SELECT * FROM project_changes WHERE project_id=$1 AND path=$2`, [id, path]);
  return rows[0] ?? null;
}
async function logAction(id: string, path: string, action: string) {
  await pool.query(`INSERT INTO change_log (project_id, path, action) VALUES ($1,$2,$3)`, [id, path, action]);
}
async function refreshStatus(id: string) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM project_changes WHERE project_id=$1`, [id]);
  await pool.query(`UPDATE projects SET status=$2, updated_at=now() WHERE id=$1`, [id, rows[0].n ? "modified" : "analyzed"]);
}
async function saveChange(id: string, path: string, kind: "text" | "image", buf: Buffer, action: string) {
  const dir = join(projectDir(id), "changes");
  await mkdir(dir, { recursive: true });
  const stored = createHash("sha256").update(path).digest("hex").slice(0, 32);
  await writeFile(join(dir, stored), buf);
  const sha = createHash("sha256").update(buf).digest("hex");
  await pool.query(
    `INSERT INTO project_changes (project_id, path, kind, stored_name, size_bytes, sha256)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (project_id, path) DO UPDATE
       SET kind=EXCLUDED.kind, size_bytes=EXCLUDED.size_bytes, sha256=EXCLUDED.sha256, updated_at=now()`,
    [id, path, kind, stored, buf.length, sha]);
  await logAction(id, path, action);
  await refreshStatus(id);
}
async function removeChange(id: string, path: string, action = "restore") {
  const ch = await getChange(id, path);
  if (!ch) return false;
  await rm(storedPath(id, ch.stored_name), { force: true });
  await pool.query(`DELETE FROM project_changes WHERE project_id=$1 AND path=$2`, [id, path]);
  await logAction(id, path, action);
  await refreshStatus(id);
  return true;
}

export async function fileRoutes(app: FastifyInstance) {
  type Q = { Params: { id: string }; Querystring: { path?: string; version?: string } };

  // Contenido de un archivo (texto) o info (imagen / binario)
  app.get<Q>("/api/projects/:id/file", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const entry = await findEntry(p, req.query.path);
    if (!entry) return bad(reply, 404, "NOT_FOUND", "Ese archivo no existe dentro del APK.");
    const cls = classify(entry.path);
    const change = await getChange(p.id, entry.path);
    const base = { path: entry.path, size: entry.size, kind: cls.kind, modified: !!change, reason: cls.reason ?? null };

    if (cls.kind === "text") {
      if (entry.size > MAX_TEXT) return { ...base, editable: false, reason: "Archivo de texto demasiado grande para editar aquí (máx. 2 MB)." };
      const useChange = change && req.query.version !== "original";
      const buf = useChange ? await readFile(storedPath(p.id, change.stored_name)) : await readZipEntry(p.original_path, entry.path, MAX_TEXT);
      if (!buf) return bad(reply, 404, "NOT_FOUND", "No se pudo leer el archivo.");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch { return { ...base, editable: false, reason: "No es texto UTF-8 válido (parece binario)." }; }
      if (text.includes("\0")) return { ...base, editable: false, reason: "Contiene bytes nulos: es un archivo binario." };
      return { ...base, editable: true, content: text };
    }
    return { ...base, editable: cls.kind === "image" && cls.editable };
  });

  // Bytes de una imagen para previsualizar (original o actual)
  app.get<Q>("/api/projects/:id/raw", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const entry = await findEntry(p, req.query.path);
    if (!entry) return bad(reply, 404, "NOT_FOUND", "Ese archivo no existe dentro del APK.");
    if (classify(entry.path).kind !== "image") return bad(reply, 415, "NOT_IMAGE", "Solo se pueden previsualizar imágenes.");
    const change = await getChange(p.id, entry.path);
    const buf = change && req.query.version !== "original"
      ? await readFile(storedPath(p.id, change.stored_name))
      : await readZipEntry(p.original_path, entry.path, MAX_IMG * 2);
    if (!buf) return bad(reply, 404, "NOT_FOUND", "No se pudo leer la imagen.");
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .type(IMG_MIME[ext(entry.path)] ?? "application/octet-stream")
      .send(buf);
  });

  // Guardar texto editado
  app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>(
    "/api/projects/:id/file", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
      const p = await getProject(req.params.id, req.userId);
      if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
      const { path, content } = req.body ?? {};
      if (typeof content !== "string") return bad(reply, 400, "BAD_BODY", "Falta el contenido del archivo.");
      const entry = await findEntry(p, path);
      if (!entry) return bad(reply, 404, "NOT_FOUND", "Ese archivo no existe dentro del APK.");
      const cls = classify(entry.path);
      if (cls.kind !== "text" || !cls.editable) return bad(reply, 422, "NOT_EDITABLE", cls.reason ?? "Este archivo no se puede editar.");
      if (entry.size > MAX_TEXT) return bad(reply, 413, "TOO_BIG", "El archivo original es demasiado grande para editar (máx. 2 MB).");
      const buf = Buffer.from(content, "utf8");
      if (buf.length > MAX_TEXT) return bad(reply, 413, "TOO_BIG", "El contenido supera 2 MB.");

      const warnings: string[] = [];
      if (ext(entry.path) === "json") {
        try { JSON.parse(content); } catch (e: any) { warnings.push("El JSON guardado no es válido: " + e.message); }
      }
      const original = await readZipEntry(p.original_path, entry.path, MAX_TEXT);
      if (original && original.equals(buf)) {
        await removeChange(p.id, entry.path);
        return { ok: true, modified: false, warnings };
      }
      await saveChange(p.id, entry.path, "text", buf, "edit");
      return { ok: true, modified: true, size: buf.length, warnings };
    });

  // Reemplazar una imagen
  app.post<{ Params: { id: string }; Querystring: { path?: string } }>("/api/projects/:id/replace", async (req, reply) => {
    let buf: Buffer;
    try {
      const part = await req.file({ limits: { fileSize: MAX_IMG } });
      if (!part) return bad(reply, 400, "NO_FILE", "Envía la imagen en el campo 'file'.");
      buf = await part.toBuffer();
    } catch (e: any) {
      if (e?.code === "FST_REQ_FILE_TOO_LARGE") return bad(reply, 413, "TOO_BIG", "La imagen supera 5 MB.");
      throw e;
    }
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const entry = await findEntry(p, req.query.path);
    if (!entry) return bad(reply, 404, "NOT_FOUND", "Ese archivo no existe dentro del APK.");
    const cls = classify(entry.path);
    if (cls.kind !== "image" || !cls.editable) return bad(reply, 422, "NOT_EDITABLE", cls.reason ?? "Este recurso no es una imagen reemplazable.");
    const got = sniffImage(buf);
    if (!got) return bad(reply, 422, "BAD_IMAGE", "El archivo no es una imagen válida (PNG, JPG, WebP o GIF).");
    const want = IMG_TYPE[ext(entry.path)];
    if (got !== want)
      return bad(reply, 422, "FORMAT_MISMATCH", `El recurso original es ${want.toUpperCase()} y la imagen nueva es ${got.toUpperCase()}. Conviértela al mismo formato.`);
    await saveChange(p.id, entry.path, "image", buf, "replace");
    return { ok: true, modified: true, size: buf.length };
  });

  // Restaurar un archivo (con ?path=) o descartar todos los cambios (sin path)
  app.delete<Q>("/api/projects/:id/changes", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    if (req.query.path !== undefined) {
      if (typeof req.query.path !== "string") return bad(reply, 400, "BAD_PATH", "Ruta inválida.");
      const ok = await removeChange(p.id, req.query.path);
      if (!ok) return bad(reply, 404, "NO_CHANGE", "Ese archivo no tiene cambios guardados.");
      return { ok: true };
    }
    await rm(join(projectDir(p.id), "changes"), { recursive: true, force: true });
    await pool.query(`DELETE FROM project_changes WHERE project_id=$1`, [p.id]);
    await logAction(p.id, "*", "discard");
    await refreshStatus(p.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/changes", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const changes = (await pool.query(
      `SELECT path, kind, size_bytes, updated_at FROM project_changes WHERE project_id=$1 ORDER BY updated_at DESC`, [p.id])).rows;
    const log = (await pool.query(
      `SELECT path, action, at FROM change_log WHERE project_id=$1 ORDER BY at DESC LIMIT 50`, [p.id])).rows;
    return { changes, log };
  });
}
