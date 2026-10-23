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
import { signingConfigured } from "./services/signing.js";
import { ZipError } from "./services/zipSafe.js";

const app = Fastify({ logger: { redact: ["req.headers.authorization"] } });

app.setErrorHandler((e: any, req, reply) => {
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

  const missing: string[] = [];
  if (!(await has("zip", ["-v"]))) missing.push("zip");
  if (!(await has(config.zipalignBin, ["-h"]))) missing.push("zipalign");
  if (!(await has(config.apksignerBin, ["--version"]))) missing.push("apksigner");
  if (!(await has(config.keytoolBin, ["-help"]))) missing.push("keytool");
  if (!signingConfigured()) missing.push("KEYSTORE_PASSWORD");
  r.missing = missing;
  r.build = missing.length === 0;
  return r;
});
await app.register(projectRoutes);
await app.register(fileRoutes);
await app.register(buildRoutes);

try { await migrate(); migrated = true; await recoverBuilds(); }
catch (e) { app.log.error("Migración fallida: la base de datos no responde"); }
await app.listen({ port: config.port, host: "0.0.0.0" });
