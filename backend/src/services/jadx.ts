import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

const run = promisify(execFile);

export class JadxError extends Error {}

// Nombre de clase Java con paquete (por ejemplo com.ejemplo.MainActivity o com.ejemplo.Main$Inner)
export const JADX_CLASS = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;
export const MAX_JAVA_BYTES = 2 * 1024 * 1024;

// De entre los .java generados, elige el de la clase pedida (las clases internas salen dentro de la externa)
export function pickJavaFile(files: string[], cls: string): string | null {
  const outer = cls.split("$")[0].replace(/\./g, "/") + ".java";
  return files.find((f) => f === outer || f.endsWith("/" + outer)) ?? files[0] ?? null;
}

async function listJava(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let ents;
  try { ents = await readdir(join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listJava(dir, p)));
    else if (e.name.endsWith(".java")) out.push(p);
    if (out.length > 200) break;
  }
  return out;
}

// Decompila UNA clase del APK a Java aproximado (solo lectura). No decompila recursos para ahorrar memoria.
export async function decompileClass(apk: string, cls: string, workDir: string): Promise<{ code: string; truncated: boolean }> {
  if (!JADX_CLASS.test(cls) || cls.length > 300) throw new JadxError("Nombre de clase inválido.");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  let output = "";
  try {
    const opts = config.jadxJavaOpts;
    const r = await run(config.jadxBin, ["--no-res", "--threads-count", "1", "--single-class", cls, "-d", workDir, apk], {
      timeout: config.jadxTimeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, JAVA_TOOL_OPTIONS: opts, JAVA_OPTS: opts, JADX_OPTS: opts },
    });
    output = String(r.stdout) + String(r.stderr);
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new JadxError("JADX no está instalado en el servidor.");
    if (e?.killed) throw new JadxError("JADX tardó demasiado. Prueba con otra clase o con un APK más pequeño.");
    output = String(e?.stdout ?? "") + String(e?.stderr ?? ""); // JADX termina con error aunque haya generado la clase
  }
  const file = pickJavaFile(await listJava(workDir), cls);
  if (!file) {
    const mem = /OutOfMemory|Java heap|Killed/i.test(output);
    const tail = output.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("Picked up")).slice(-3).join(" | ").slice(0, 300);
    throw new JadxError(mem ? "Memoria insuficiente en el servidor para decompilar este APK."
      : `No se encontró la clase ${cls} en el APK (revisa el nombre completo con el paquete). ${tail}`);
  }
  const full = join(workDir, file);
  const size = (await stat(full)).size;
  const code = (await readFile(full, "utf8")).slice(0, MAX_JAVA_BYTES);
  return { code, truncated: size > MAX_JAVA_BYTES };
}
