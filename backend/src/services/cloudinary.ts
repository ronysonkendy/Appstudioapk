import { config } from "../config.js";
import { cloudSign } from "./cloudSign.js";

export const cloudConfigured = () => !!(config.cloudinaryCloud && config.cloudinaryKey && config.cloudinarySecret);
const api = (path: string) => `https://api.cloudinary.com/v1_1/${config.cloudinaryCloud}/${path}`;

// Sube un bloque (ya cifrado) como archivo "raw". Devuelve la URL para descargarlo después.
export async function cloudUpload(publicId: string, data: Buffer): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = cloudSign({ public_id: publicId, overwrite: "true", timestamp }, config.cloudinarySecret);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), "bloque.bin");
  form.append("api_key", config.cloudinaryKey);
  form.append("timestamp", String(timestamp));
  form.append("public_id", publicId);
  form.append("overwrite", "true");
  form.append("signature", signature);
  const res = await fetch(api("raw/upload"), { method: "POST", body: form });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.secure_url) throw new Error(`Cloudinary ${res.status}: ${json?.error?.message ?? "sin detalle"}`);
  return json.secure_url as string;
}

export async function cloudDestroy(publicId: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", config.cloudinaryKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", cloudSign({ public_id: publicId, timestamp }, config.cloudinarySecret));
  const res = await fetch(api("raw/destroy"), { method: "POST", body: form });
  if (!res.ok) throw new Error(`Cloudinary ${res.status} al borrar`);
}
