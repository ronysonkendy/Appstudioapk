import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

// Los ids son UUID generados por el servidor: nunca se aceptan rutas del cliente.
const UUID = /^[0-9a-f-]{36}$/;

export function projectDir(id: string) {
  if (!UUID.test(id)) throw new Error("invalid id");
  return join(config.storageDir, "projects", id);
}
export async function ensureProjectDir(id: string) {
  const d = projectDir(id);
  await mkdir(d, { recursive: true });
  return d;
}
export async function removeProjectDir(id: string) {
  await rm(projectDir(id), { recursive: true, force: true });
}
