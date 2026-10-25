import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { removeProjectDir } from "../storage/local.js";
import { userStorage } from "../services/usage.js";
import { dropBackupPrefix } from "../services/backup.js";

const UUID = /^[0-9a-f-]{36}$/;

function bad(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function adminRoutes(app: FastifyInstance) {
  // Uso de la cuenta actual (cualquier usuario con sesión)
  app.get("/api/usage", async (req) => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM projects WHERE owner_id=$1`, [req.userId]);
    return {
      projects: rows[0].n, projectLimit: config.maxProjectsPerUser,
      storageBytes: await userStorage(req.userId), storageLimitBytes: config.maxStorageMbPerUser * 1024 * 1024,
      maxBuildsPerProject: config.maxBuildsPerProject,
    };
  });

  app.get("/api/admin/users", async (req, reply) => {
    if (req.userRole !== "admin") return bad(reply, 403, "FORBIDDEN", "Solo para administradores.");
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, u.created_at,
        (SELECT count(*)::int FROM projects p WHERE p.owner_id = u.id::text) AS projects,
        COALESCE((SELECT SUM(p.size_bytes) FROM projects p WHERE p.owner_id = u.id::text), 0)
        + COALESCE((SELECT SUM(b.size_bytes) FROM builds b JOIN projects p ON p.id = b.project_id
                    WHERE p.owner_id = u.id::text AND b.status = 'success'), 0) AS storage
       FROM users u ORDER BY u.created_at`);
    return rows.map((r) => ({ ...r, storage: Number(r.storage) }));
  });

  app.patch<{ Params: { id: string }; Body: { role?: unknown } }>("/api/admin/users/:id", async (req, reply) => {
    if (req.userRole !== "admin") return bad(reply, 403, "FORBIDDEN", "Solo para administradores.");
    const id = req.params.id;
    if (!UUID.test(id)) return bad(reply, 404, "NOT_FOUND", "Usuario no encontrado.");
    if (id === req.userId) return bad(reply, 422, "SELF", "No puedes cambiar tu propio rol.");
    const role = req.body?.role;
    if (role !== "admin" && role !== "user") return bad(reply, 422, "BAD_ROLE", "El rol debe ser admin o user.");
    const r = await pool.query(`UPDATE users SET role=$2 WHERE id=$1`, [id, role]);
    return r.rowCount ? { ok: true } : bad(reply, 404, "NOT_FOUND", "Usuario no encontrado.");
  });

  // Borra la cuenta, sus proyectos y sus archivos
  app.delete<{ Params: { id: string } }>("/api/admin/users/:id", async (req, reply) => {
    if (req.userRole !== "admin") return bad(reply, 403, "FORBIDDEN", "Solo para administradores.");
    const id = req.params.id;
    if (!UUID.test(id)) return bad(reply, 404, "NOT_FOUND", "Usuario no encontrado.");
    if (id === req.userId) return bad(reply, 422, "SELF", "No puedes borrar tu propia cuenta.");
    const { rows } = await pool.query(`SELECT id FROM projects WHERE owner_id=$1`, [id]);
    for (const p of rows) { await removeProjectDir(p.id); await dropBackupPrefix(`projects/${p.id}/`); }
    await pool.query(`DELETE FROM projects WHERE owner_id=$1`, [id]);
    const r = await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
    return r.rowCount ? reply.code(204).send() : bad(reply, 404, "NOT_FOUND", "Usuario no encontrado.");
  });
}
