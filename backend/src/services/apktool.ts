import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { config } from "../config.js";

const run = promisify(execFile);

// Decodifica recursos y manifiesto (-s: no decodifica el código; el DEX se conserva tal cual).
export async function decodeApk(original: string, outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  try {
    await run(config.apktoolBin, ["d", "-f", "-s", "-o", outDir, original], {
      timeout: config.apktoolTimeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, JAVA_TOOL_OPTIONS: config.apktoolJavaOpts },
    });
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error("Apktool no está instalado en el servidor.");
    const lines = String(e?.stderr || e?.stdout || e?.message || e)
      .split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("Picked up"));
    const mem = /OutOfMemory|Java heap|Killed/i.test(lines.join(" "));
    throw new Error((mem ? "Memoria insuficiente en el servidor para este APK. " : "Apktool no pudo decodificar este APK. ")
      + lines.slice(-4).join(" | ").slice(0, 600));
  }
}
