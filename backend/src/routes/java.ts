import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../db/pool.js";
import { projectDir } from "../storage/local.js";
import { ensureLocalFile } from "../services/backup.js";
import { JADX_CLASS, JadxError, decompileClass } from "../services/jadx.js";
import { runQueued } from "../services/queue.js";

const UUID = /^[0-9a-f-]{36}$/;

function bad(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function javaRoutes(app: FastifyInstance) {
  // Java aproximado de una clase del APK ORIGINAL (solo lectura: no se puede recompilar)
  app.get<{ Params: { id: string }; Querystring: { class?: string } }>("/api/projects/:id/java", async (req, reply) => {
    if (!UUID.test(req.params.id)) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const { rows } = await pool.query(`SELECT original_path FROM projects WHERE id=$1 AND owner_id=$2`, [req.params.id, req.userId]);
    if (!rows[0]) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const cls = (req.query.class ?? "").trim();
    if (!cls || !JADX_CLASS.test(cls) || cls.length > 300)
      return bad(reply, 422, "BAD_CLASS", "Escribe el nombre completo de la clase, por ejemplo com.ejemplo.MainActivity.");
    if (!(await ensureLocalFile(rows[0].original_path)))
      return bad(reply, 410, "FILE_GONE", "El APK original ya no está en el servidor. Vuelve a importarlo.");

    const dir = join(projectDir(req.params.id), "jadx");
    const cacheFile = join(dir, createHash("sha1").update(cls).digest("hex") + ".java");
    try { return { class: cls, code: await readFile(cacheFile, "utf8"), cached: true, truncated: false }; } catch { /* sin caché */ }

    const work = join(projectDir(req.params.id), "work", "jadx-" + randomUUID());
    try {
      const r = await runQueued(() => decompileClass(rows[0].original_path, cls, work));
      await mkdir(dir, { recursive: true });
      await writeFile(cacheFile, r.code, "utf8");
      return { class: cls, code: r.code, cached: false, truncated: r.truncated };
    } catch (e) {
      if (e instanceof JadxError) return bad(reply, 422, "JADX_FAILED", e.message);
      throw e;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}
