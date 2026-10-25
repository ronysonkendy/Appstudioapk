import { createHash } from "node:crypto";

// Firma de la API de Cloudinary: parámetros ordenados, "clave=valor" unidos con &, más el secreto, en SHA-1.
export function cloudSign(params: Record<string, string | number>, secret: string): string {
  const s = Object.keys(params).filter((k) => params[k] !== "").sort().map((k) => `${k}=${params[k]}`).join("&");
  return createHash("sha1").update(s + secret).digest("hex");
}
