import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";

declare module "fastify" {
  interface FastifyRequest { userId: string; userRole: string }
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const BEARER = /^Bearer ([0-9a-f]{64})$/;

// Solo se guarda el hash del token: si alguien lee la base de datos, no puede usar las sesiones.
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 days')`,
    [sha(token), userId]);
  return token;
}

export async function authenticate(header?: string): Promise<{ id: string; email: string; role: string } | null> {
  const m = BEARER.exec(header ?? "");
  if (!m) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha(m[1])]);
  return rows[0] ?? null;
}

export async function deleteSession(header?: string) {
  const m = BEARER.exec(header ?? "");
  if (m) await pool.query(`DELETE FROM sessions WHERE token_hash=$1`, [sha(m[1])]);
}
