import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { projectDir } from "../storage/local.js";
import { rebuildApk } from "../services/rebuild.js";
import { listZip, ZipError } from "../services/zipSafe.js";
import { compareEntries } from "../services/compare.js";
import { userStorage } from "../services/usage.js";
import { decodedDir, hasDecodedDir, rehydrateDecoded } from "../services/decodedStore.js";
import { dropBackup, ensureLocalFile, scheduleBackup } from "../services/backup.js";
import { enqueue } from "../services/queue.js";

const UUID = /^[0-9a-f-]{36}$/;
const TOKEN = /^[0-9a-f]{48}$/;

function bad(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

async function getProject(id: string, uid: string) {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(`SELECT * FROM projects WHERE id=$1 AND owner_id=$2`, [id, uid]);
  const row = rows[0] ?? null;
  if (row) await ensureLocalFile(row.original_path); // si el disco se borró, se restaura desde Cloudinary
  return row;
}
async function getBuild(projectId: string, buildId: string) {
  if (!UUID.test(buildId)) return null;
  const { rows } = await pool.query(`SELECT * FROM builds WHERE id=$1 AND project_id=$2`, [buildId, projectId]);
  return rows[0] ?? null;
}

function view(b: any) {
  const live = b.status === "success" && !b.revoked && b.expires_at && new Date(b.expires_at) > new Date();
  return {
    id: b.id, number: b.number, status: b.status, verified: b.verified, fileName: b.file_name,
    sizeBytes: b.size_bytes ? Number(b.size_bytes) : null, sha256: b.sha256, signerSha256: b.signer_sha256,
    changesCount: b.changes_count, error: b.error, log: b.log, createdAt: b.created_at, finishedAt: b.finished_at,
    expiresAt: b.expires_at, revoked: b.revoked, downloadPath: live ? "/api/download/" + b.download_token : null,
    note: b.note ?? "", published: !!b.published,
  };
}

// Retención: se conservan las últimas N compilaciones y todas las publicadas.
async function pruneBuilds(projectId: string) {
  const { rows } = await pool.query(
    `SELECT id, stored_name FROM builds WHERE project_id=$1 AND published=false AND status IN ('success','failed')
     ORDER BY created_at DESC OFFSET $2`, [projectId, config.maxBuildsPerProject]);
  for (const r of rows) {
    if (r.stored_name) {
      await rm(join(projectDir(projectId), "builds", r.stored_name), { force: true });
      await dropBackup(join(projectDir(projectId), "builds", r.stored_name));
    }
    await pool.query(`DELETE FROM builds WHERE id=$1`, [r.id]);
  }
}

export async function recoverBuilds() {
  await pool.query(
    `UPDATE builds SET status='failed', error='El servidor se reinició durante la compilación.', finished_at=now()
     WHERE status IN ('queued','running')`);
}

async function runBuild(projectId: string, buildId: string) {
  await pool.query(`UPDATE builds SET status='running' WHERE id=$1`, [buildId]);
  const workDir = join(projectDir(projectId), "work", buildId);
  let log: string[] = [];
  try {
    const { rows: pr } = await pool.query(`SELECT * FROM projects WHERE id=$1`, [projectId]);
    const p = pr[0];
    if (!p) throw new Error("El proyecto ya no existe.");
    if (!(await ensureLocalFile(p.original_path)))
      throw new Error("El APK original ya no está en el servidor (el disco gratuito se reinicia). Vuelve a importarlo.");
    const { rows } = await pool.query(`SELECT path, stored_name FROM project_changes WHERE project_id=$1 ORDER BY path`, [projectId]);
    const changes = rows.map((r) => ({ path: r.path as string, file: join(projectDir(projectId), "changes", r.stored_name) }));
    for (const c of changes) await ensureLocalFile(c.file); // cambios guardados en el respaldo si el disco se borró
    const { rows: nr } = await pool.query(`SELECT number FROM builds WHERE id=$1`, [buildId]);

    const { rows: dr } = await pool.query(`SELECT count(*)::int AS n FROM decode_edits WHERE project_id=$1`, [projectId]);
    const decEdits: number = dr[0].n;
    const useApktool = p.decode_status === "ready" && decEdits > 0;

    if (useApktool && !(await hasDecodedDir(projectId))) await rehydrateDecoded(projectId, p.original_path, p.decode_mode === "full");

    const res = await rebuildApk(p.original_path, changes, workDir, useApktool ? decodedDir(projectId) : undefined);
    log = res.log;
    const buildsDir = join(projectDir(projectId), "builds");
    await mkdir(buildsDir, { recursive: true });
    const stored = buildId + ".apk";
    await rename(res.outPath, join(buildsDir, stored));
    scheduleBackup(join(buildsDir, stored));
    const fileName = safeName(`${p.package_name ?? "app"}-${p.version_name ?? "v"}-kendy-${nr[0].number}.apk`);
    await pool.query(
      `UPDATE builds SET status='success', verified=$2, file_name=$3, stored_name=$4, size_bytes=$5, sha256=$6,
         signer_sha256=$7, changes_count=$8, log=$9, download_token=$10,
         expires_at=now() + make_interval(hours => $11::int), finished_at=now()
       WHERE id=$1`,
      [buildId, res.verified, fileName, stored, res.size, res.sha256, res.signerSha256, changes.length + (useApktool ? decEdits : 0),
       log.join("\n"), randomBytes(24).toString("hex"), config.linkTtlHours]);
    await pruneBuilds(projectId);
  } catch (e: any) {
    const l: string[] = e?.buildLog ?? log;
    await pool.query(`UPDATE builds SET status='failed', error=$2, log=$3, finished_at=now() WHERE id=$1`,
      [buildId, String(e?.message ?? e).slice(0, 800), l.join("\n")]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function buildRoutes(app: FastifyInstance) {
  type P = { Params: { id: string; bid: string } };

  app.post<{ Params: { id: string } }>("/api/projects/:id/builds", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    if ((await userStorage(req.userId)) >= config.maxStorageMbPerUser * 1024 * 1024)
      return bad(reply, 403, "QUOTA", "Superaste tu espacio. Elimina compilaciones o proyectos antes de compilar.");
    const busy = await pool.query(`SELECT 1 FROM builds WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1`, [p.id]);
    if (busy.rowCount) return bad(reply, 409, "BUSY", "Ya hay una compilación en curso para este proyecto.");
    const { rows: n } = await pool.query(`SELECT COALESCE(MAX(number),0)+1 AS n FROM builds WHERE project_id=$1`, [p.id]);
    const id = randomUUID();
    await pool.query(`INSERT INTO builds (id, project_id, number, status) VALUES ($1,$2,$3,'queued')`, [id, p.id, n[0].n]);
    enqueue(() => runBuild(p.id, id));
    return reply.code(202).send({ id, number: n[0].n, status: "queued" });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/builds", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    if (!p) return bad(reply, 404, "NOT_FOUND", "Proyecto no encontrado.");
    const { rows } = await pool.query(`SELECT * FROM builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20`, [p.id]);
    return rows.map(view);
  });

  app.get<P>("/api/projects/:id/builds/:bid", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    const b = p && await getBuild(p.id, req.params.bid);
    return b ? view(b) : bad(reply, 404, "NOT_FOUND", "Compilación no encontrada.");
  });

  // Nota de la versión y marca de "publicada" (solo una por proyecto)
  app.patch<{ Params: { id: string; bid: string }; Body: { note?: unknown; published?: unknown } }>(
    "/api/projects/:id/builds/:bid", async (req, reply) => {
      const p = await getProject(req.params.id, req.userId);
      const b = p && await getBuild(p.id, req.params.bid);
      if (!b) return bad(reply, 404, "NOT_FOUND", "Compilación no encontrada.");
      const { note, published } = req.body ?? {};
      if (note !== undefined) {
        if (typeof note !== "string" || note.length > 200) return bad(reply, 422, "BAD_NOTE", "La nota debe ser texto de hasta 200 caracteres.");
        await pool.query(`UPDATE builds SET note=$2 WHERE id=$1`, [b.id, note.trim()]);
      }
      if (published !== undefined) {
        if (typeof published !== "boolean") return bad(reply, 422, "BAD_PUBLISHED", "published debe ser verdadero o falso.");
        if (published && b.status !== "success") return bad(reply, 422, "NOT_READY", "Solo se puede publicar una compilación exitosa.");
        if (published) await pool.query(`UPDATE builds SET published=false WHERE project_id=$1`, [p.id]);
        await pool.query(`UPDATE builds SET published=$2 WHERE id=$1`, [b.id, published]);
      }
      return view((await pool.query(`SELECT * FROM builds WHERE id=$1`, [b.id])).rows[0]);
    });

  // Comparar una compilación con el APK original o con otra compilación
  app.get<{ Params: { id: string; bid: string }; Querystring: { with?: string } }>(
    "/api/projects/:id/builds/:bid/compare", async (req, reply) => {
      const p = await getProject(req.params.id, req.userId);
      const b = p && await getBuild(p.id, req.params.bid);
      if (!b || b.status !== "success") return bad(reply, 404, "NOT_FOUND", "Compilación no encontrada.");
      const w = req.query.with ?? "original";
      let aPath = p.original_path, against = "APK original";
      if (w !== "original") {
        const o = await getBuild(p.id, w);
        if (!o || o.status !== "success") return bad(reply, 404, "NOT_FOUND", "La compilación de comparación no existe.");
        aPath = join(projectDir(p.id), "builds", o.stored_name);
        against = `Compilación #${o.number}`;
      }
      const bPath = join(projectDir(p.id), "builds", b.stored_name);
      let sizeA: number, sizeB: number;
      await ensureLocalFile(aPath); await ensureLocalFile(bPath);
      try { sizeA = (await stat(aPath)).size; sizeB = (await stat(bPath)).size; }
      catch { return bad(reply, 410, "FILE_GONE", "Un archivo ya no está en el servidor y no hay respaldo."); }
      try {
        const [A, B] = await Promise.all([listZip(aPath), listZip(bPath)]);
        return { version: b.number, against, sizeA, sizeB, ...compareEntries(A, B) };
      } catch (e) {
        if (e instanceof ZipError) return bad(reply, 422, e.code, e.message);
        throw e;
      }
    });

  // Generar un enlace nuevo (renueva token y caducidad)
  app.post<P>("/api/projects/:id/builds/:bid/link", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    const b = p && await getBuild(p.id, req.params.bid);
    if (!b) return bad(reply, 404, "NOT_FOUND", "Compilación no encontrada.");
    if (b.status !== "success") return bad(reply, 422, "NOT_READY", "Solo las compilaciones exitosas tienen enlace.");
    const { rows } = await pool.query(
      `UPDATE builds SET download_token=$2, revoked=false, expires_at=now() + make_interval(hours => $3::int)
       WHERE id=$1 RETURNING *`, [b.id, randomBytes(24).toString("hex"), config.linkTtlHours]);
    return view(rows[0]);
  });

  // Revocar el enlace
  app.delete<P>("/api/projects/:id/builds/:bid/link", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    const b = p && await getBuild(p.id, req.params.bid);
    if (!b) return bad(reply, 404, "NOT_FOUND", "Compilación no encontrada.");
    await pool.query(`UPDATE builds SET revoked=true WHERE id=$1`, [b.id]);
    return { ok: true };
  });

  // Eliminar compilación y su archivo
  app.delete<P>("/api/projects/:id/builds/:bid", async (req, reply) => {
    const p = await getProject(req.params.id, req.userId);
    const b = p && await getBuild(p.id, req.params.bid);
    if (!b) return bad(reply, 404, "NOT_FOUND", "Compilación no encontrada.");
    if (b.status === "queued" || b.status === "running") return bad(reply, 409, "BUSY", "La compilación sigue en curso.");
    if (b.stored_name) {
      await rm(join(projectDir(p.id), "builds", b.stored_name), { force: true });
      await dropBackup(join(projectDir(p.id), "builds", b.stored_name));
    }
    await pool.query(`DELETE FROM builds WHERE id=$1`, [b.id]);
    return reply.code(204).send();
  });

  // Descarga pública por token (el token es el secreto; caduca y se puede revocar)
  app.get<{ Params: { token: string } }>("/api/download/:token", async (req, reply) => {
    const t = req.params.token;
    const { rows } = TOKEN.test(t)
      ? await pool.query(
          `SELECT * FROM builds WHERE download_token=$1 AND status='success' AND revoked=false AND expires_at > now()`, [t])
      : { rows: [] as any[] };
    const b = rows[0];
    if (!b) return bad(reply, 404, "LINK_INVALID", "El enlace no existe, fue revocado o caducó.");
    const file = join(projectDir(b.project_id), "builds", b.stored_name);
    let size: number;
    await ensureLocalFile(file); // si el disco se borró, vuelve desde el respaldo
    try { size = (await stat(file)).size; }
    catch { return bad(reply, 410, "FILE_GONE", "El archivo ya no está en el servidor y no hay respaldo. Reconstruye el APK."); }
    return reply
      .header("Content-Type", "application/vnd.android.package-archive")
      .header("Content-Disposition", `attachment; filename="${safeName(b.file_name)}"`)
      .header("Content-Length", size)
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(createReadStream(file));
  });
                                                                                                          }
