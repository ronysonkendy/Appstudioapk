import { config } from "../config.js";
import { cloudSign } from "./cloudSign.js";

// Dos modos: firmado (API key + secret: sube, sobrescribe y borra) o sin firma (solo cloud name + upload preset: sube, no borra).
export const cloudSigned = () => !!(config.cloudinaryKey && config.cloudinarySecret);
export const cloudConfigured = () => !!config.cloudinaryCloud && (cloudSigned() || !!config.cloudinaryPreset);
const api = (path: string) => `https://api.cloudinary.com/v1_1/${config.cloudinaryCloud}/${path}`;

// Sube un bloque (ya cifrado) como archivo "raw". Devuelve la URL para descargarlo y el id con el que quedó guardado.
export async function cloudUpload(publicId: string, data: Buffer): Promise<{ url: string; publicId: string }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), "bloque.bin");
  form.append("public_id", publicId);
  if (cloudSigned()) {
    const timestamp = Math.floor(Date.now() / 1000);
    form.append("api_key", config.cloudinaryKey);
    form.append("timestamp", String(timestamp));
    form.append("overwrite", "true");
    form.append("signature", cloudSign({ public_id: publicId, overwrite: "true", timestamp }, config.cloudinarySecret));
  } else {
    form.append("upload_preset", config.cloudinaryPreset);
  }
  const res = await fetch(api("raw/upload"), { method: "POST", body: form });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.secure_url) throw new Error(`Cloudinary ${res.status}: ${json?.error?.message ?? "sin detalle"}`);
  return { url: json.secure_url as string, publicId: (json.public_id as string) ?? publicId };
}

// Borrar exige la firma (API secret). Sin ella no se puede: se ignora.
export async function cloudDestroy(publicId: string): Promise<void> {
  if (!cloudSigned()) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", config.cloudinaryKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", cloudSign({ public_id: publicId, timestamp }, config.cloudinarySecret));
  const res = await fetch(api("raw/destroy"), { method: "POST", body: form });
  if (!res.ok) throw new Error(`Cloudinary ${res.status} al borrar`);
}
