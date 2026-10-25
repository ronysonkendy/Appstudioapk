export interface CmpEntry { path: string; size: number; crc: number; isDir: boolean }
export interface CmpResult {
  added: string[]; removed: string[]; changed: { path: string; sizeA: number; sizeB: number }[];
  counts: { added: number; removed: number; changed: number };
}

// Compara dos listas de archivos de un APK (A = base, B = nueva). La firma (META-INF) no cuenta.
export function compareEntries(a: CmpEntry[], b: CmpEntry[], limit = 500): CmpResult {
  const keep = (e: CmpEntry) => !e.isDir && !e.path.startsWith("META-INF/");
  const ma = new Map(a.filter(keep).map((e) => [e.path, e] as const));
  const mb = new Map(b.filter(keep).map((e) => [e.path, e] as const));
  const added = [...mb.keys()].filter((p) => !ma.has(p)).sort();
  const removed = [...ma.keys()].filter((p) => !mb.has(p)).sort();
  const changed = [...mb.keys()].filter((p) => ma.has(p) && ma.get(p)!.crc !== mb.get(p)!.crc).sort()
    .map((p) => ({ path: p, sizeA: ma.get(p)!.size, sizeB: mb.get(p)!.size }));
  return {
    added: added.slice(0, limit), removed: removed.slice(0, limit), changed: changed.slice(0, limit),
    counts: { added: added.length, removed: removed.length, changed: changed.length },
  };
}
