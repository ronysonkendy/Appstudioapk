import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { ensureKeystore, KEY_ALIAS } from "./signing.js";
import { listZip } from "./zipSafe.js";

const run = promisify(execFile);

export interface BuildChange { path: string; file: string }
export interface BuildResult {
  outPath: string; size: number; sha256: string; verified: boolean; signerSha256: string | null; log: string[];
}

const scrub = (s: string) => (config.keystorePassword ? s.split(config.keystorePassword).join("***") : s);

async function tool(
  log: string[], label: string, bin: string, args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; okCodes?: number[]; timeoutMs?: number; tail?: boolean } = {},
): Promise<string> {
  try {
    const { stdout } = await run(bin, args, {
      cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? config.buildTimeoutMs, maxBuffer: 16 * 1024 * 1024,
    });
    log.push(`✔ ${label}`);
    return String(stdout);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      const m = `${label}: la herramienta "${bin}" no está instalada en el servidor.`;
      log.push("✖ " + m);
      throw new Error(m);
    }
    if (opts.okCodes?.includes(e?.code)) { log.push(`✔ ${label} (nada que quitar)`); return ""; }
    const lines = String(e?.stderr || e?.stdout || e?.message || e)
      .split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("Picked up"));
    const detail = scrub((opts.tail ? lines.slice(-6) : lines.slice(0, 5)).join(" | ").slice(0, 700));
    log.push(`✖ ${label}: ${detail}`);
    throw new Error(`${label} falló: ${detail}`);
  }
}

export function parseVerify(out: string) {
  return {
    verified: /^Verifies\s*$/m.test(out),
    signerSha256: /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(out)?.[1] ?? null,
  };
}

async function sha256File(p: string) {
  const h = createHash("sha256");
  for await (const c of createReadStream(p)) h.update(c);
  return h.digest("hex");
}

// Flujo normal: copiar original -> quitar firma antigua -> aplicar cambios -> zipalign -> apksigner -> verificar.
// Con decodedDir (cambios de Apktool): se reconstruye primero con Apktool y luego se aplican los cambios de texto/imagen.
export async function rebuildApk(original: string, changes: BuildChange[], workDir: string, decodedDir?: string): Promise<BuildResult> {
  const log: string[] = [];
  try {
    const ks = await ensureKeystore();
    log.push("✔ Clave de firma lista");
    await rm(workDir, { recursive: true, force: true });
    await mkdir(join(workDir, "files"), { recursive: true });
    const work = join(workDir, "work.apk"), aligned = join(workDir, "aligned.apk"), out = join(workDir, "signed.apk");

    if (decodedDir) {
      await tool(log, "Reconstruir recursos con Apktool", config.apktoolBin,
        ["b", "-f", decodedDir, "-o", work, ...(config.aapt2Bin ? ["-a", config.aapt2Bin] : [])],
        { env: { ...process.env, JAVA_TOOL_OPTIONS: config.apktoolJavaOpts }, timeoutMs: config.apktoolTimeoutMs, tail: true });
      const present = new Set((await listZip(work)).map((e) => e.path));
      for (const c of changes)
        if (!present.has(c.path)) log.push(`⚠ No aplicado: ${c.path} (esa ruta cambió al reconstruir con Apktool)`);
      changes = changes.filter((c) => present.has(c.path));
    } else {
      await copyFile(original, work);
      log.push("✔ Copia de trabajo del APK original");
      await tool(log, "Quitar firma original", "zip",
        ["-q", "-d", work, "META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA", "META-INF/*.EC", "META-INF/MANIFEST.MF"],
        { okCodes: [12] });
    }

    if (changes.length) {
      for (const c of changes) {
        const dest = join(workDir, "files", c.path);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(c.file, dest);
      }
      await tool(log, `Aplicar ${changes.length} archivo(s) modificado(s)`, "zip",
        ["-q", "-X", work, ...changes.map((c) => c.path)], { cwd: join(workDir, "files") });
    } else {
      log.push("• Sin cambios: se vuelve a firmar el APK original");
    }

    await tool(log, "Alinear (zipalign)", config.zipalignBin, ["-f", "-p", "4", work, aligned]);
    await tool(log, "Firmar (apksigner)", config.apksignerBin, [
      "sign", "--ks", ks, "--ks-key-alias", KEY_ALIAS, "--ks-pass", "env:KENDY_KS_PASS",
      "--key-pass", "env:KENDY_KS_PASS", "--out", out, aligned,
    ], { env: { ...process.env, KENDY_KS_PASS: config.keystorePassword } });

    const v = parseVerify(await tool(log, "Verificar firma", config.apksignerBin, ["verify", "--verbose", "--print-certs", out]));
    if (!v.verified) throw new Error("apksigner no pudo verificar la firma del APK resultante.");
    await tool(log, "Comprobar alineación", config.zipalignBin, ["-c", "-p", "4", out]);

    const st = await stat(out);
    return { outPath: out, size: st.size, sha256: await sha256File(out), verified: v.verified, signerSha256: v.signerSha256, log };
  } catch (e: any) {
    e.buildLog = log;
    throw e;
  } finally {
    if (decodedDir) await rm(join(decodedDir, "build"), { recursive: true, force: true }).catch(() => {});
  }
}
