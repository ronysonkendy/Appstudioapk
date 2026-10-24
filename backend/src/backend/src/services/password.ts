import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as unknown as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

// Formato guardado: scrypt$<sal base64>$<hash base64>. Nunca se guarda la contraseña.
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, s, h] = stored.split("$");
  if (kind !== "scrypt" || !s || !h) return false;
  const expected = Buffer.from(h, "base64");
  const hash = await scryptAsync(pw, Buffer.from(s, "base64"), 64);
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}
