import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { ensureProjectDir, removeProjectDir, projectDir } from "../storage/local.js";
import { analyzeApk, extractIcon } from "../services/analyze.js";
import { listZip, categorize, ZipError } from "../services/zipSafe.js";
import { classify } from "../services/editable.js";

const OWNER = "local"; // TODO módulo 6: autenticación real

function err(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function projectRoutes(app: FastifyInstance) {
  app.post("/api/projects", async (req, reply) => {
    const part = await req.file();
    if (!part) return err(reply, 400, "NO_FILE", "Envía un archivo APK en el campo 'file'.");
    if (!/\.apk$/i.test(part.filename)) return err(reply, 400, "BAD_EXT", "El archivo debe tener extensión .apk.");

    const id = randomUUID();
    const dir = await ensureProjectDir(id);
    const dest = join(dir, "original.apk");
    const hash = createHash("sha256");
    let bytes = 0;
    part.file.on("data", (c: Buffer) => { bytes += c.length; hash.update(c); });

    try {
      await pipeline(part.file, createWriteStream(dest));
      if (part.file.truncated)
        throw new ZipError("TOO_BIG", `El archivo supera el límite de ${config.maxApkBytes / 1024 / 1024} MB.`);
      const fh = await open(dest, "r");
      const magic = Buffer.alloc(4);
      await fh.read(magic, 0, 4, 0);
      await fh.close();
      if (magic.toString("hex") !== "504b0304") throw new ZipError("NOT_APK", "El archivo no es un APK/ZIP válido.");

      const { info } = await analyzeApk(dest);
      const name = info.appLabel ?? part.filename.replace(/\.apk$/i, "");
      await pool.query(
        `INSERT INTO projects (id, owner_id, name, package_name, version_name, version_code, min_sdk, target_sdk,
          original_path, original_sha256, size_bytes, info) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, OWNER, name, info.packageName, info.versionName, info.versionCode, info.minSdk, info.targetSdk,
         dest, hash.digest("hex"), bytes, info]);
      return reply.code(201).send({ id, name, sizeBytes: bytes, info });
    } catch (e) {
      await removeProjectDir(id);
      if (e instanceof ZipError) return err(reply, e.code === "TOO_BIG" ? 413 : 422, e.code, e.message);
      req.log.error(e);
      return err(reply, 500, "INTERNAL", "Error interno al procesar el APK.");
    }
  });

  app.get("/api/projects", async () => {
    const { rows } = await pool.query(
      `SELECT id, name, package_name, version_name, size_bytes, status, updated_at FROM projects
       WHERE owner_id=$1 ORDER BY updated_at DESC`, [OWNER]);
    return rows;
  });

  async function getProject(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const { rows } = await pool.query(`SELECT * FROM projects WHERE id=$1 AND owner_id=$2`, [id, OWNER]);
    return rows[0] ?? null;
  }

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const p = await getProject(req.params.id);
    return p ?? err(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/api/projects/:id/files", async (req, reply) => {
    const p = await getProject(req.params.id);
    if (!p) return err(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const q = req.query.q?.toLowerCase();
    const entries = await listZip(p.original_path);
    const { rows: ch } = await pool.query(`SELECT path FROM project_changes WHERE project_id=$1`, [p.id]);
    const changed = new Set(ch.map((r) => r.path));
    return entries.filter((e) => !e.isDir && (!q || e.path.toLowerCase().includes(q)))
      .map((e) => {
        const c = classify(e.path);
        return { path: e.path, size: e.size, category: categorize(e.path), kind: c.kind, editable: c.editable, modified: changed.has(e.path) };
      });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/icon", async (req, reply) => {
    const p = await getProject(req.params.id);
    if (!p) return err(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const ch = p.info.iconPath
      ? (await pool.query(`SELECT stored_name FROM project_changes WHERE project_id=$1 AND path=$2`, [p.id, p.info.iconPath])).rows[0]
      : null;
    const buf = ch
      ? await readFile(join(projectDir(p.id), "changes", ch.stored_name))
      : await extractIcon(p.original_path, p.info.iconPath);
    if (!buf) return err(reply, 404, "NO_ICON", "Icono no disponible como imagen (puede ser un icono adaptativo XML).");
    return reply.header("Cache-Control", "no-store").type(p.info.iconPath.endsWith(".png") ? "image/png" : "image/webp").send(buf);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const p = await getProject(req.params.id);
    if (!p) return err(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    await pool.query(`DELETE FROM projects WHERE id=$1`, [p.id]);
    await removeProjectDir(p.id);
    return reply.code(204).send();
  });
                                                                                                                                     }
