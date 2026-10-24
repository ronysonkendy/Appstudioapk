import type { FastifyInstance } from "fastify";
import { rm, stat } from "node:fs/promises";
import { pool } from "../db/pool.js";
import { decodeApk } from "../services/apktool.js";
import { enqueue } from "../services/queue.js";
import {
  MAX_DECODED, decodedDir, editedPaths, isEditablePath, listDecoded, readDecoded,
  resetDecoded, restoreAllDecoded, restoreDecoded, writeDecoded,
} from "../services/decodedStore.js";
import { PropError, applyProperties, readProperties, type PropInput } from "../services/properties.js";

const UUID = /^[0-9a-f-]{36}$/;

function bad(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
async function getProject(id: string, uid: string) {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(`SELECT * FROM projects WHERE id=$1 AND owner_id=$2`, [id, uid]);
  return rows[0] ?? null;
}

export async function recoverDecodes() {
  await pool.query(
    `UPDATE projects SET decode_status='failed', decode_error='El servidor se reinició durante la decodificación.'
     WHERE decode_status='running'`);
}

async function runDecode(id: string) {
  try {
    const { rows } = await pool.query(`SELECT original_path FROM projects WHERE id=$1`, [id]);
    if (!rows[0]) return;
    try { await stat(rows[0].original_path); }
    catch { throw new Error("El APK original ya no está en el servidor (el disco gratuito se reinicia). Vuelve a importarlo."); }
    await resetDecoded(id);
    await decodeApk(rows[0].original_path, decodedDir(id));
    await pool.query(`UPDATE projects SET decode_status='ready', decode_error=NULL WHERE id=$1`, [id]);
  } catch (e: any) {
    await rm(decodedDir(id), { recursive: true, force: true }).catch(() => {});
    await pool.query(`UPDATE projects SET decode_status='failed', decode_error=$2 WHERE id=$1`,
      [id, String(e?.message ?? e).slice(0, 800)]);
  }
}

export async function decodedRoutes(app: FastifyInstance) {
  type Q = { Params: { id: string }; Querystring: { path?: string; version?: string } };

  // Iniciar (o repetir) la decodificación. Repetirla borra los cambios de Apktool.
  app.post<{ Params: { id: string } }>("/api/projects/:id/decode", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    if (p.decode_status === "running") return bad(reply, 409, "BUSY", "Ya se está decodificando este proyecto.");
    await pool.query(`UPDATE projects SET decode_status='running', decode_error=NULL WHERE id=$1`, [p.id]);
    enqueue(() => runDecode(p.id));
    return reply.code(202).send({ status: "running" });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/decoded", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    if (p.decode_status !== "ready") return { status: p.decode_status, error: p.decode_error, files: [] };
    const edited = await editedPaths(p.id);
    const files = (await listDecoded(p.id)).map((f) => ({ ...f, modified: edited.has(f.path) }));
    return { status: "ready", error: null, files };
  });

  app.get<Q>("/api/projects/:id/decoded/file", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p || p.decode_status !== "ready") return bad(reply, 404, "NOT_READY", "Primero decodifica el APK.");
    const path = req.query.path;
    if (!isEditablePath(path)) return bad(reply, 422, "NOT_EDITABLE", "Ese archivo no se puede editar.");
    let content: string;
    try { content = await readDecoded(p.id, path, req.query.version === "original"); }
    catch { return bad(reply, 404, "NOT_FOUND", "Ese archivo no existe en el APK decodificado."); }
    if (Buffer.byteLength(content) > MAX_DECODED)
      return { path, kind: "text", editable: false, modified: false, reason: "Archivo demasiado grande para editar (máx. 1 MB)." };
    const modified = (await editedPaths(p.id)).has(path);
    return { path, size: Buffer.byteLength(content), kind: "text", editable: true, modified, reason: null, content };
  });

  app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>(
    "/api/projects/:id/decoded/file", { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
      const p = await getProject(req.params.id, req.userId);
      if (!p || p.decode_status !== "ready") return bad(reply, 404, "NOT_READY", "Primero decodifica el APK.");
      const { path, content } = req.body ?? {};
      if (!isEditablePath(path)) return bad(reply, 422, "NOT_EDITABLE", "Ese archivo no se puede editar.");
      if (typeof content !== "string") return bad(reply, 400, "BAD_BODY", "Falta el contenido del archivo.");
      if (Buffer.byteLength(content) > MAX_DECODED) return bad(reply, 413, "TOO_BIG", "El contenido supera 1 MB.");
      const warnings: string[] = [];
      if (/\.xml$/.test(path) && !/^\s*<[\s\S]*>\s*$/.test(content)) warnings.push("El XML parece incompleto o mal formado.");
      try {
        const modified = await writeDecoded(p.id, path, content);
        return { ok: true, modified, warnings };
      } catch { return bad(reply, 404, "NOT_FOUND", "Ese archivo no existe en el APK decodificado."); }
    });

  // Restaurar un archivo (con ?path=) o todos los cambios de Apktool (sin path)
  app.delete<Q>("/api/projects/:id/decoded/changes", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p || p.decode_status !== "ready") return bad(reply, 404, "NOT_READY", "Primero decodifica el APK.");
    if (req.query.path !== undefined) {
      if (!isEditablePath(req.query.path)) return bad(reply, 422, "NOT_EDITABLE", "Ruta inválida.");
      const ok = await restoreDecoded(p.id, req.query.path);
      if (!ok) return bad(reply, 404, "NO_CHANGE", "Ese archivo no tiene cambios guardados.");
    } else await restoreAllDecoded(p.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/properties", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p || p.decode_status !== "ready") return bad(reply, 404, "NOT_READY", "Primero decodifica el APK.");
    try { return { properties: await readProperties(p.id) }; }
    catch { return bad(reply, 500, "INTERNAL", "No se pudieron leer las propiedades del APK decodificado."); }
  });

  app.put<{ Params: { id: string }; Body: PropInput }>("/api/projects/:id/properties", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p || p.decode_status !== "ready") return bad(reply, 404, "NOT_READY", "Primero decodifica el APK.");
    try {
      const warnings = await applyProperties(p.id, req.body ?? {});
      return { ok: true, warnings, properties: await readProperties(p.id) };
    } catch (e) {
      if (e instanceof PropError) return bad(reply, 422, "BAD_PROPERTY", e.message);
      throw e;
    }
  });
    }
