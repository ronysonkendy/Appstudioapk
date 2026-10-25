import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export const CHUNK = 8 * 1024 * 1024; // 8 MiB: con el cifrado queda bajo el límite de 10 MB de Cloudinary gratis

export const deriveKey = (passphrase: string) => scryptSync(passphrase, "kendy-backup-v1", 32);

// Bloque = iv(12) + etiqueta GCM(16) + datos cifrados. Cada bloque se cifra por separado.
export function encryptChunk(buf: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptChunk(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < 28) throw new Error("Bloque de respaldo dañado.");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
