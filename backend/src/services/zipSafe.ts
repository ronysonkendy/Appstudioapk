import yauzl from "yauzl";
import { config } from "../config.js";

export class ZipError extends Error {
  constructor(public code: "CORRUPT" | "UNSAFE" | "TOO_BIG" | "NOT_APK", message: string) { super(message); }
}
export interface ZipEntryInfo { path: string; size: number; compressedSize: number; isDir: boolean }

function open(file: string): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, z) => {
      if (err || !z) return rej(new ZipError("CORRUPT", "El archivo está dañado o no es un ZIP/APK válido."));
      res(z);
    }));
}

export async function listZip(file: string): Promise<ZipEntryInfo[]> {
  const zip = await open(file);
  return new Promise((resolve, reject) => {
    const out: ZipEntryInfo[] = [];
    let total = 0;
    zip.on("error", () => reject(new ZipError("CORRUPT", "El archivo está dañado o incompleto.")));
    zip.on("end", () => resolve(out));
    zip.on("entry", (e: yauzl.Entry) => {
      const p = e.fileName;
      if (p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.split("/").includes(".."))
        return (zip.close(), reject(new ZipError("UNSAFE", `Ruta peligrosa en el APK: ${p}`)));
      total += e.uncompressedSize;
      if (out.length >= config.maxEntries) return (zip.close(), reject(new ZipError("TOO_BIG", "Demasiados archivos en el APK.")));
      if (total > config.maxUncompressedBytes) return (zip.close(), reject(new ZipError("TOO_BIG", "El contenido descomprimido excede el límite.")));
      if (e.uncompressedSize > 1024 * 1024 && e.compressedSize > 0 &&
          e.uncompressedSize / e.compressedSize > config.maxCompressionRatio)
        return (zip.close(), reject(new ZipError("UNSAFE", `Ratio de compresión sospechoso en ${p} (posible zip bomb).`)));
      out.push({ path: p, size: e.uncompressedSize, compressedSize: e.compressedSize, isDir: p.endsWith("/") });
      zip.readEntry();
    });
    zip.readEntry();
  });
}

export async function readZipEntry(file: string, name: string, maxBytes = 5 * 1024 * 1024): Promise<Buffer | null> {
  const zip = await open(file);
  return new Promise((resolve, reject) => {
    zip.on("error", () => reject(new ZipError("CORRUPT", "No se pudo leer el archivo.")));
    zip.on("end", () => resolve(null));
    zip.on("entry", (e: yauzl.Entry) => {
      if (e.fileName !== name) return zip.readEntry();
      if (e.uncompressedSize > maxBytes) return (zip.close(), reject(new ZipError("TOO_BIG", "Archivo demasiado grande para previsualizar.")));
      zip.openReadStream(e, (err, stream) => {
        if (err || !stream) return reject(new ZipError("CORRUPT", "No se pudo leer la entrada."));
        const chunks: Buffer[] = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => { zip.close(); resolve(Buffer.concat(chunks)); });
        stream.on("error", () => reject(new ZipError("CORRUPT", "Error de lectura.")));
      });
    });
    zip.readEntry();
  });
}

export function categorize(path: string): string {
  if (path === "AndroidManifest.xml") return "manifest";
  if (/^classes\d*\.dex$/.test(path)) return "dex";
  if (path.startsWith("META-INF/")) return "signature";
  if (path.startsWith("lib/")) return "native";
  if (path.startsWith("assets/")) return "assets";
  if (path === "resources.arsc") return "compiled-resources";
  if (path.startsWith("res/")) {
    if (/\.(png|jpe?g|webp|gif)$/i.test(path)) return "image";
    if (path.endsWith(".xml")) return "resource-xml";
    return "resource";
  }
  return "other";
           }
