import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { authenticate, createSession, deleteSession } from "../services/auth.js";
import { AuthError, googleKeyResolver, verifyFirebaseIdToken } from "../services/firebaseToken.js";

// Límite estricto para frenar abusos del inicio de sesión.
const limit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

function bad(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function authRoutes(app: FastifyInstance) {
  // Único método de acceso: Google (vía Firebase Authentication). El navegador manda el ID token.
  app.post<{ Body: { idToken?: unknown } }>("/api/auth/google", limit, async (req, reply) => {
    let claims;
    try { claims = await verifyFirebaseIdToken(req.body?.idToken, config.firebaseProjectId, googleKeyResolver); }
    catch (e) {
      if (e instanceof AuthError) return bad(reply, 401, "BAD_TOKEN", e.message);
      throw e;
    }
    const email = (claims.email ?? "").toLowerCase();
    if (!email || claims.email_verified !== true)
      return bad(reply, 403, "EMAIL_UNVERIFIED", "Tu cuenta de Google no tiene un correo verificado.");
    if (config.allowedEmails.length && !config.allowedEmails.includes(email))
      return bad(reply, 403, "NOT_ALLOWED", "Esta cuenta de Google no tiene permiso para entrar.");

    const find = async (sql: string, v: unknown) => (await pool.query(sql, [v])).rows[0] as
      { id: string; email: string; role: string } | undefined;
    let u = await find(`SELECT id, email, role FROM users WHERE firebase_uid=$1`, claims.sub);
    if (!u) {
      // Cuentas anteriores (de cuando había contraseña) se enlazan por correo.
      u = await find(`SELECT id, email, role FROM users WHERE email=$1`, email);
      if (u) await pool.query(`UPDATE users SET firebase_uid=$2 WHERE id=$1`, [u.id, claims.sub]);
    }
    if (!u) {
      const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM users`);
      const first = c[0].n === 0;
      const isAdminEmail = !!config.adminEmail && email === config.adminEmail;
      if (!first && !isAdminEmail && !config.allowRegister)
        return bad(reply, 403, "REGISTER_CLOSED", "El registro está cerrado en este servidor.");
      try {
        const { rows } = await pool.query(
          `INSERT INTO users (email, firebase_uid, role, name, picture) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, role`,
          [email, claims.sub, first || isAdminEmail ? "admin" : "user", claims.name ?? null, claims.picture ?? null]);
        u = rows[0];
      } catch (e: any) {
        if (e?.code !== "23505") throw e;
        u = await find(`SELECT id, email, role FROM users WHERE email=$1`, email);
      }
      // La primera cuenta hereda los proyectos creados antes de que existieran cuentas.
      if (u && first) await pool.query(`UPDATE projects SET owner_id=$1 WHERE owner_id='local'`, [u.id]);
    }
    if (!u) return bad(reply, 500, "INTERNAL", "No se pudo crear la cuenta.");
    if (config.adminEmail && email === config.adminEmail && u.role !== "admin") {
      await pool.query(`UPDATE users SET role='admin' WHERE id=$1`, [u.id]);
      u.role = "admin";
    }
    await pool.query(`UPDATE users SET name=COALESCE($2,name), picture=COALESCE($3,picture) WHERE id=$1`,
      [u.id, claims.name ?? null, claims.picture ?? null]);
    return { token: await createSession(u.id), user: { id: u.id, email: u.email, role: u.role } };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const u = await authenticate(req.headers.authorization);
    return u ? { user: u } : bad(reply, 401, "UNAUTHORIZED", "Sesión no válida.");
  });

  app.post("/api/auth/logout", async (req) => {
    await deleteSession(req.headers.authorization);
    return { ok: true };
  });
}
