export type FileKind = "text" | "image" | "binary";
export interface FileClass { kind: FileKind; editable: boolean; reason?: string }

const TEXT_EXT = new Set(["txt", "json", "html", "htm", "css", "js", "xml", "csv", "md", "properties", "cfg", "ini", "yml", "yaml", "svg", "conf", "log"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
export const IMG_TYPE: Record<string, "png" | "jpg" | "webp" | "gif"> = {
  png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp", gif: "gif",
};

export function ext(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "";
}

const bin = (reason: string): FileClass => ({ kind: "binary", editable: false, reason });

export function classify(path: string): FileClass {
  const e = ext(path);
  if (path === "AndroidManifest.xml") return bin("Manifiesto compilado (binario). Se podrá editar con Apktool en el módulo 5.");
  if (/^classes\d*\.dex$/.test(path)) return bin("Código DEX compilado: no es texto. Requiere JADX/Apktool (módulo 5).");
  if (path === "resources.arsc") return bin("Tabla de recursos compilada (binario). Requiere Apktool (módulo 5).");
  if (path.startsWith("META-INF/")) return bin("Archivo de firma. Se regenera al firmar el APK; no se edita.");
  if (path.startsWith("lib/")) return bin("Biblioteca nativa (.so). No se puede editar de forma segura.");
  if (/\.9\.png$/i.test(path)) return bin("Imagen 9-patch compilada: reemplazarla puede romper la interfaz. Requiere Apktool (módulo 5).");
  const rawArea = path.startsWith("assets/") || path.startsWith("res/raw/");
  if (rawArea && TEXT_EXT.has(e)) return { kind: "text", editable: true };
  if (path.startsWith("res/") && e === "xml") return bin("XML compilado de Android (binario). Se podrá editar con Apktool en el módulo 5.");
  if (IMG_EXT.has(e) && (path.startsWith("res/") || path.startsWith("assets/"))) return { kind: "image", editable: true };
  return bin("Archivo binario o de un tipo que no se puede editar de forma segura.");
}

export function sniffImage(b: Buffer): "png" | "jpg" | "webp" | "gif" | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "gif";
  return null;
}
