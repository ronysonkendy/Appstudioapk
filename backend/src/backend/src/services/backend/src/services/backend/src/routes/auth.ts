import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../services/password.js";
import { authenticate, createSession, deleteSession } from "../services/auth.js";

const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,}$/;
// Límite estricto para frenar intentos de adivinar contraseñas.
const limit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

function bad(reply: any, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
const readCreds = (b: any) => ({
  email: typeof b?.email === "string" ? b.email.trim().toLowerCase() : "",
  password: typeof b?.password === "string" ? b.password : "",
});

let dummyHash: string | null = null;

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email?: unknown; password?: unknown } }>("/api/auth/register", limit, async (req, reply) => {
    const { email, password } = readCreds(req.body);
    if (!EMAIL.test(email) || email.length > 200) return bad(reply, 422, "BAD_EMAIL", "Escribe un correo válido.");
    if (password.length < 8 || password.length > 200)
      return bad(reply, 422, "BAD_PASSWORD", "La contraseña debe tener entre 8 y 200 caracteres.");
    const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM users`);
    const first = c[0].n === 0;
    if (!first && !config.allowRegister) return bad(reply, 403, "REGISTER_CLOSED", "El registro está cerrado en este servidor.");
    const hash = await hashPassword(password);
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role`,
        [email, hash, first ? "admin" : "user"]);
      const u = rows[0];
      // La primera cuenta es admin y hereda los proyectos creados antes de que existieran cuentas.
      if (first) await pool.query(`UPDATE projects SET owner_id=$1 WHERE owner_id='local'`, [u.id]);
      return reply.code(201).send({ token: await createSession(u.id), user: u });
    } catch (e: any) {
      if (e?.code === "23505") return bad(reply, 409, "EMAIL_TAKEN", "Ese correo ya está registrado.");
      throw e;
    }
  });

  app.post<{ Body: { email?: unknown; password?: unknown } }>("/api/auth/login", limit, async (req, reply) => {
    const { email, password } = readCreds(req.body);
    const { rows } = await pool.query(`SELECT id, email, role, password_hash FROM users WHERE email=$1`, [email]);
    const u = rows[0];
    // Se calcula el hash aunque el correo no exista, para que el tiempo no delate qué correos están registrados.
    dummyHash ??= await hashPassword("contraseña-de-relleno");
    const ok = await verifyPassword(password, u?.password_hash ?? dummyHash);
    if (!u || !ok) return bad(reply, 401, "BAD_CREDENTIALS", "Correo o contraseña incorrectos.");
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
