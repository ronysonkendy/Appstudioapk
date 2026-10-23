// Una sola tarea pesada a la vez (compilar, decodificar): el plan gratuito tiene poca memoria.
let chain: Promise<void> = Promise.resolve();
export const enqueue = (fn: () => Promise<void>) => { chain = chain.then(fn).catch(() => {}); };
