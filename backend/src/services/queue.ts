// Una sola tarea pesada a la vez (compilar, decodificar, decompilar): el plan gratuito tiene poca memoria.
let chain: Promise<void> = Promise.resolve();
export const enqueue = (fn: () => Promise<void>) => { chain = chain.then(fn).catch(() => {}); };

// Igual que enqueue, pero devuelve el resultado (o el error) a quien lo pidió.
export function runQueued<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.then(() => {}, () => {});
  return p;
}
