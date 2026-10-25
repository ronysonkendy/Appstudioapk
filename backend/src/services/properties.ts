import { listDecoded, readDecoded, writeDecoded } from "./decodedStore.js";
import {
  PropError, checkName, checkPermission, checkVersionCode, checkVersionName, parseProps,
  removePermission, setLabelInManifest, setLabelInString, setYmlValue, type Props,
} from "./propsText.js";

export { PropError };

export async function readProperties(id: string): Promise<Props> {
  const manifest = await readDecoded(id, "AndroidManifest.xml");
  const yml = await readDecoded(id, "apktool.yml").catch(() => "");
  const strings = await readDecoded(id, "res/values/strings.xml").catch(() => "");
  return parseProps(manifest, yml, strings);
}

export interface PropInput {
  appName?: unknown; versionName?: unknown; versionCode?: unknown;
  removePermissions?: unknown; confirmPermissions?: unknown;
}

export async function applyProperties(id: string, inp: PropInput): Promise<string[]> {
  const warnings: string[] = [];
  const props = await readProperties(id);

  if (inp.appName !== undefined) {
    const name = checkName(inp.appName);
    const src = props.appNameSource;
    if (src?.kind === "string") {
      // Se cambia en todos los idiomas que traduzcan el mismo texto (si no, ganaría la traducción).
      const files = (await listDecoded(id)).map((f) => f.path).filter((p) => /^res\/values[^/]*\/strings\.xml$/.test(p));
      let n = 0;
      for (const f of files) {
        const next = setLabelInString(await readDecoded(id, f), src.key, name);
        if (next !== null) { await writeDecoded(id, f, next); n++; }
      }
      if (!n) throw new PropError("No se encontró el texto del nombre en los recursos.");
      if (n > 1) warnings.push(`El nombre se cambió en ${n} idiomas.`);
    } else if (src?.kind === "manifest") {
      const next = setLabelInManifest(await readDecoded(id, "AndroidManifest.xml"), name);
      if (next === null) throw new PropError("No se encontró el nombre en el manifiesto.");
      await writeDecoded(id, "AndroidManifest.xml", next);
    } else throw new PropError("La app no declara un nombre visible en el manifiesto.");
  }

  for (const field of ["versionName", "versionCode"] as const) {
    if (inp[field] === undefined) continue;
    const value = field === "versionName" ? checkVersionName(inp[field]) : checkVersionCode(inp[field]);
    const next = setYmlValue(await readDecoded(id, "apktool.yml"), field, value);
    if (next === null) throw new PropError(`No se encontró ${field} en apktool.yml.`);
    await writeDecoded(id, "apktool.yml", next);
  }

  if (inp.removePermissions !== undefined) {
    if (!Array.isArray(inp.removePermissions) || inp.removePermissions.length > 100) throw new PropError("Lista de permisos inválida.");
    if (inp.confirmPermissions !== true) throw new PropError("Quitar permisos requiere confirmación explícita.");
    let text = await readDecoded(id, "AndroidManifest.xml");
    for (const raw of inp.removePermissions) {
      const perm = checkPermission(raw);
      const r = removePermission(text, perm);
      if (!r.removed) warnings.push(`El permiso ${perm} no estaba en el manifiesto.`);
      text = r.text;
    }
    await writeDecoded(id, "AndroidManifest.xml", text);
  }
  return warnings;
}
