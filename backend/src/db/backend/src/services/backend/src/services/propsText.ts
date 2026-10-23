// Funciones puras para leer/editar el texto decodificado por Apktool (sin acceso a disco).
export class PropError extends Error {}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const escString = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'").replace(/"/g, '\\"');
export const unescString = (s: string) =>
  s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export type NameSource = { kind: "string"; key: string } | { kind: "manifest" } | null;
export interface Props {
  packageName: string | null; appName: string | null; appNameSource: NameSource;
  versionName: string | null; versionCode: string | null; permissions: string[];
}

export function parseProps(manifest: string, yml: string, stringsXml: string): Props {
  const packageName = /<manifest\b[^>]*?\spackage="([^"]*)"/.exec(manifest)?.[1] ?? null;
  const labelRaw = /<application\b[^>]*?\sandroid:label="([^"]*)"/.exec(manifest)?.[1] ?? null;
  let appName: string | null = labelRaw;
  let appNameSource: NameSource = labelRaw !== null ? { kind: "manifest" } : null;
  const ref = labelRaw !== null ? /^@string\/(.+)$/.exec(labelRaw) : null;
  if (ref) {
    const key = ref[1];
    appNameSource = { kind: "string", key };
    const v = new RegExp(`<string\\s+name="${escapeRe(key)}"[^>]*>([\\s\\S]*?)</string>`).exec(stringsXml);
    appName = v ? unescString(v[1]) : null;
  }
  const versionCode = /^[ \t]*versionCode:[ \t]*['"]?([^'"\r\n]*?)['"]?[ \t\r]*$/m.exec(yml)?.[1] ?? null;
  const versionName = /^[ \t]*versionName:[ \t]*['"]?([^'"\r\n]*?)['"]?[ \t\r]*$/m.exec(yml)?.[1] ?? null;
  const permissions = [...manifest.matchAll(/<uses-permission(?:-sdk-23)?\s[^>]*?android:name="([^"]+)"/g)].map((x) => x[1]);
  return { packageName, appName, appNameSource, versionName, versionCode, permissions: [...new Set(permissions)] };
}

export function setLabelInString(xml: string, key: string, name: string): string | null {
  const re = new RegExp(`(<string\\s+name="${escapeRe(key)}"[^>]*>)([\\s\\S]*?)(</string>)`);
  if (!re.test(xml)) return null;
  return xml.replace(re, (_m, a: string, _b: string, c: string) => a + escString(name) + c);
}

export function setLabelInManifest(manifest: string, name: string): string | null {
  const re = /(<application\b[^>]*?\sandroid:label=")([^"]*)(")/;
  if (!re.test(manifest)) return null;
  return manifest.replace(re, (_m, a: string, _b: string, c: string) => a + escAttr(name) + c);
}

export function setYmlValue(yml: string, field: "versionName" | "versionCode", value: string): string | null {
  const re = new RegExp(`^([ \\t]*${field}:[ \\t]*)['"]?[^'"\\r\\n]*['"]?[ \\t]*$`, "m");
  if (!re.test(yml)) return null;
  return yml.replace(re, (_m, a: string) => `${a}'${value}'`);
}

export function removePermission(manifest: string, perm: string): { text: string; removed: number } {
  const re = new RegExp(`[ \\t]*<uses-permission(?:-sdk-23)?\\s[^>]*?android:name="${escapeRe(perm)}"[^>]*?/>[ \\t]*\\r?\\n?`, "g");
  let removed = 0;
  const text = manifest.replace(re, () => { removed++; return ""; });
  return { text, removed };
}

export function checkName(n: unknown): string {
  if (typeof n !== "string") throw new PropError("Nombre inválido.");
  const t = n.trim();
  if (!t || t.length > 60) throw new PropError("El nombre debe tener entre 1 y 60 caracteres.");
  if (/[\u0000-\u001f]/.test(t)) throw new PropError("El nombre contiene caracteres no permitidos.");
  return t;
}
export function checkVersionName(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9._+\- ]{1,40}$/.test(v.trim()))
    throw new PropError("La versión solo admite letras, números, espacios y . _ + - (máx. 40).");
  return v.trim();
}
export function checkVersionCode(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!/^\d{1,10}$/.test(s) || Number(s) > 2100000000 || Number(s) < 1)
    throw new PropError("El número de versión debe ser un entero entre 1 y 2100000000.");
  return String(Number(s));
}
export function checkPermission(p: unknown): string {
  if (typeof p !== "string" || !/^[A-Za-z0-9_.]{3,200}$/.test(p)) throw new PropError("Nombre de permiso inválido.");
  return p;
                          }
