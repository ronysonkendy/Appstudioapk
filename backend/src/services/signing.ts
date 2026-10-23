import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

const run = promisify(execFile);

export const KEY_ALIAS = "kendy";
export const keystorePath = () => join(config.storageDir, "keys", "kendy.keystore");
export const signingConfigured = () => config.keystorePassword.length >= 8;

// Crea (si no existe) la clave de firma del servidor. La contraseña solo viaja por variable
// de entorno: nunca por argumentos de línea de comandos ni por los registros.
export async function ensureKeystore(): Promise<string> {
  if (!signingConfigured())
    throw new Error("Falta la variable KEYSTORE_PASSWORD (mínimo 8 caracteres) en el servidor.");
  const ks = keystorePath();
  try { await access(ks); return ks; } catch { /* no existe: se crea */ }
  await mkdir(join(config.storageDir, "keys"), { recursive: true });
  await run(config.keytoolBin, [
    "-genkeypair", "-keystore", ks, "-alias", KEY_ALIAS, "-keyalg", "RSA", "-keysize", "2048",
    "-validity", "10000", "-dname", "CN=Kendy APK Studio", "-storepass:env", "KENDY_KS_PASS", "-keypass:env", "KENDY_KS_PASS",
  ], { env: { ...process.env, KENDY_KS_PASS: config.keystorePassword }, timeout: config.toolTimeoutMs });
  return ks;
}
