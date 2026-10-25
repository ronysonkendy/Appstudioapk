import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, constants } from "node:fs/promises";
import { config } from "./config.js";
import { migrate, pool } from "./db/pool.js";
import { projectRoutes } from "./routes/projects.js";
import { fileRoutes } from "./routes/files.js";
import { buildRoutes, recoverBuilds } from "./routes/builds.js";
import { decodedRoutes, recoverDecodes } from "./routes/decoded.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { authenticate } from "./services/auth.js";
import { signingConfigured } from "./services/signing.js";
import { backupEnabled, backupStatus } from "./services/backup.js";
import { ZipError } from "./services/zipSafe.js";

const app = Fastify({ logger: { redact: ["req.headers.authorization"] } });

app.setErrorHandler((e: any, req, reply) => {
  if (e?.code === "ENOENT")
    return reply.code(410).send({ error: { code: "FILE_GONE", message: "Un archivo del proyecto ya no está en el servidor y no hay respaldo (el disco gratuito se reinicia). Vuelve a importar el APK." } });
  if (e instanceof ZipError)
    return reply.code(e.code === "TOO_BIG" ? 413 : 422).send({ error: { code: e.code, message: e.message } });
  const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
  if (status === 500) req.log.error(e);
  reply.code(status).send({
    error: {
      code: status === 500 ? "INTERNAL" : (e.code ?? "BAD_REQUEST"),
      message: status === 500 ? "Error interno del servidor." : e.message,
    },
  });
});

app.decorateRequest("userId", "");
app.decorateRequest("userRole", "");
// Todo lo de /api exige sesión, salvo el login/registro y las descargas por enlace (el enlace es el secreto).
app.addHook("onRequest", async (req, reply) => {
  const url = req.url.split("?")[0];
  if (req.method === "OPTIONS" || !url.startsWith("/api/")) return;
  if (url.startsWith("/api/auth/") || url.startsWith("/api/download/")) return;
  const u = await authenticate(req.headers.authorization);
  if (!u) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Inicia sesión para continuar." } });
  req.userId = u.id;
  req.userRole = u.role;
});

await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });
await app.register(multipart, { limits: { fileSize: config.maxApkBytes, files: 1 } });
if (process.env.CORS_ORIGIN)
  await app.register(cors, { origin: process.env.CORS_ORIGIN, methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"] });
const frontendDir = process.env.FRONTEND_DIR ? resolve(process.env.FRONTEND_DIR) : null;
if (frontendDir && existsSync(frontendDir)) await app.register(fstatic, { root: frontendDir });

const run = promisify(execFile);
// true si el programa existe (aunque devuelva error al pedir ayuda)
const has = async (bin: string, args: string[]) => {
  try { await run(bin, args, { timeout: 5000 }); return true; } catch (e: any) { return e?.code !== "ENOENT"; }
};

// Las comprobaciones de herramientas arrancan Java: se guardan 60 s para no repetirlas en cada visita.
let toolsCache: { t: number; v: Record<string, unknown> } | null = null;
async function toolsStatus() {
  if (toolsCache && Date.now() - toolsCache.t < 60_000) return toolsCache.v;
  const missing: string[] = [];
  if (!(await has("zip", ["-v"]))) missing.push("zip");
  if (!(await has(config.zipalignBin, ["-h"]))) missing.push("zipalign");
  if (!(await has(config.apksignerBin, ["--version"]))) missing.push("apksigner");
  if (!(await has(config.keytoolBin, ["-help"]))) missing.push("keytool");
  const apktoolMissing: string[] = [];
  if (!(await has(config.apktoolBin, ["--version"]))) apktoolMissing.push("apktool");
  if (!(await has(config.aapt2Bin || "aapt2", ["version"]))) apktoolMissing.push("aapt2");
  const v = { missing, apktoolMissing };
  toolsCache = { t: Date.now(), v };
  return v;
}

let migrated = false;
app.get("/health", async () => {
  const r: Record<string, unknown> = { ok: true, maxMb: config.maxApkBytes / 1024 / 1024 };
  try {
    await pool.query("select 1");
    if (!migrated) { await migrate(); migrated = true; }
    r.db = true;
  } catch (e: any) { r.db = false; r.dbError = e?.code ?? "error"; r.ok = false; }
  try { const { stdout } = await run(config.aaptBin, ["v"], { timeout: 5000 }); r.aapt = true; r.aaptVersion = stdout.trim().slice(0, 60); }
  catch { r.aapt = false; r.ok = false; }
  try { await mkdir(config.storageDir, { recursive: true }); await access(config.storageDir, constants.W_OK); r.storage = true; }
  catch { r.storage = false; r.ok = false; }

  const t = await toolsStatus();
  const missing = [...(t.missing as string[])];
  if (!signingConfigured()) missing.push("KEYSTORE_PASSWORD");
  r.missing = missing;
  r.build = missing.length === 0;
  r.googleLogin = !!config.firebaseProjectId;
  r.backup = { enabled: backupEnabled(), pending: backupStatus.pending, lastError: backupStatus.lastError };
  r.apktool = (t.apktoolMissing as string[]).length === 0;
  r.apktoolMissing = t.apktoolMissing;
  return r;
});
await app.register(authRoutes);
await app.register(adminRoutes);
await app.register(projectRoutes);
await app.register(fileRoutes);
await app.register(buildRoutes);
await app.register(decodedRoutes);

try { await migrate(); migrated = true; await recoverBuilds(); await recoverDecodes(); }
catch (e) { app.log.error("Migración fallida: la base de datos no responde"); }
await app.listen({ port: config.port, host: "0.0.0.0" });
