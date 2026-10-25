import { X509Certificate, verify, type KeyObject } from "node:crypto";

export class AuthError extends Error {}
export interface FbClaims {
  sub: string; aud: string; iss: string; exp: number; iat: number;
  email?: string; email_verified?: boolean; name?: string; picture?: string;
}
export type KeyResolver = (kid: string) => Promise<KeyObject | null>;

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// Verifica un ID token de Firebase Auth (RS256) sin depender del SDK de Google.
export async function verifyFirebaseIdToken(
  token: unknown, projectId: string, resolve: KeyResolver, nowSec = Math.floor(Date.now() / 1000),
): Promise<FbClaims> {
  if (!projectId) throw new AuthError("El inicio de sesión con Google no está configurado en el servidor.");
  if (typeof token !== "string" || token.length > 4096) throw new AuthError("Token inválido.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Token inválido.");
  let header: any, payload: any;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { throw new AuthError("Token inválido."); }
  if (header?.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError("Token inválido.");
  const key = await resolve(header.kid);
  if (!key) throw new AuthError("Token firmado con una clave desconocida.");
  const ok = verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new AuthError("Firma del token inválida.");
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`)
    throw new AuthError("El token no es para esta aplicación.");
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128) throw new AuthError("Token inválido.");
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) throw new AuthError("El token expiró. Inicia sesión de nuevo.");
  if (typeof payload.iat !== "number" || payload.iat > nowSec + 300) throw new AuthError("Token inválido.");
  return payload as FbClaims;
}

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let cache: { exp: number; keys: Map<string, KeyObject> } | null = null;

async function loadCerts() {
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new AuthError("No se pudieron obtener las claves de Google.");
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  const json = (await res.json()) as Record<string, string>;
  const keys = new Map<string, KeyObject>();
  for (const [kid, pem] of Object.entries(json)) keys.set(kid, new X509Certificate(pem).publicKey);
  cache = { exp: Date.now() + maxAge * 1000, keys };
}

// Claves públicas de Google, guardadas hasta que caduquen (se vuelven a pedir si aparece una clave nueva).
export const googleKeyResolver: KeyResolver = async (kid) => {
  if (!cache || cache.exp < Date.now()) await loadCerts();
  let k = cache!.keys.get(kid);
  if (!k) { await loadCerts(); k = cache!.keys.get(kid); }
  return k ?? null;
};
