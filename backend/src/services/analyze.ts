import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { listZip, readZipEntry, categorize, ZipError, type ZipEntryInfo } from "./zipSafe.js";

const run = promisify(execFile);

export interface ApkInfo {
  packageName: string | null; versionName: string | null; versionCode: string | null;
  appLabel: string | null; minSdk: number | null; targetSdk: number | null;
  permissions: string[]; launchActivity: string | null; iconPath: string | null;
  nativeAbis: string[]; counts: Record<string, number>; totalFiles: number;
}

export function parseBadging(out: string) {
  const m = (re: RegExp) => re.exec(out)?.[1] ?? null;
  const pkg = /package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/.exec(out);
  const icons = [...out.matchAll(/application-icon-(\d+):'([^']+)'/g)]
    .map((x) => ({ dpi: Number(x[1]), path: x[2] })).sort((a, b) => b.dpi - a.dpi);
  const sdk = (s: string | null) => (s ? Number(s) : null);
  return {
    packageName: pkg?.[1] ?? null, versionCode: pkg?.[2] ?? null, versionName: pkg?.[3] ?? null,
    appLabel: m(/application-label:'([^']*)'/),
    minSdk: sdk(m(/sdkVersion:'(\d+)'/)), targetSdk: sdk(m(/targetSdkVersion:'(\d+)'/)),
    permissions: [...out.matchAll(/uses-permission: name='([^']+)'/g)].map((x) => x[1]),
    launchActivity: m(/launchable-activity: name='([^']+)'/),
    iconPath: icons[0]?.path ?? null,
  };
}

export async function analyzeApk(file: string): Promise<{ info: ApkInfo; entries: ZipEntryInfo[] }> {
  const entries = await listZip(file);
  const names = new Set(entries.map((e) => e.path));
  if (!names.has("AndroidManifest.xml"))
    throw new ZipError("NOT_APK", "El archivo es un ZIP pero no contiene AndroidManifest.xml: no parece un APK.");
  if (![...names].some((n) => /^classes\d*\.dex$/.test(n)) && !names.has("resources.arsc"))
    throw new ZipError("NOT_APK", "No se encontró código (DEX) ni recursos compilados.");

  let badging = "";
  try {
    const { stdout } = await run(config.aaptBin, ["dump", "badging", file],
      { timeout: config.toolTimeoutMs, maxBuffer: 16 * 1024 * 1024 });
    badging = stdout;
  } catch {
    throw new ZipError("NOT_APK", "No se pudo leer el manifiesto del APK con aapt (¿APK incompatible o aapt no instalado?).");
  }
  const parsed = parseBadging(badging);
  const counts: Record<string, number> = {};
  for (const e of entries) if (!e.isDir) { const c = categorize(e.path); counts[c] = (counts[c] ?? 0) + 1; }
  const abis = new Set<string>();
  for (const n of names) { const x = /^lib\/([^/]+)\//.exec(n); if (x) abis.add(x[1]); }

  return { entries, info: { ...parsed, nativeAbis: [...abis], counts, totalFiles: entries.filter((e) => !e.isDir).length } };
}

export async function extractIcon(file: string, iconPath: string | null) {
  if (!iconPath || !/\.(png|webp|jpe?g)$/i.test(iconPath)) return null; // iconos adaptativos XML: requieren Apktool (módulo 5)
  return readZipEntry(file, iconPath);
}
