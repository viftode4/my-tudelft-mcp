import { Worker, type WorkerOptions } from 'node:worker_threads';

/**
 * Start a parsing worker from either the compiled `dist` tree or the TypeScript
 * sources used by `npm test` and `npm run dev`.
 *
 * Source mode needs tsx registered *inside* the worker. Node's own type
 * stripping runs the `.ts` entry but does not rewrite its `./module.js`
 * specifiers, and `--import` in `execArgv` is not applied to worker threads on
 * the supported Node 22 floor, so the worker dies with ERR_MODULE_NOT_FOUND.
 * Registering the loader from a small eval bootstrap works on every supported
 * Node version. Compiled workers start directly and never load tsx.
 *
 * `execArgv` is always empty: parent test, eval and V8 flags are not valid here.
 */
export function startParsingWorker(workerUrl: URL, options: Omit<WorkerOptions, 'eval' | 'execArgv'>): Worker {
  if (!workerUrl.pathname.endsWith('.ts')) return new Worker(workerUrl, { ...options, execArgv: [] });
  const loader = JSON.stringify(import.meta.resolve('tsx/esm/api'));
  const bootstrap = `import { register } from ${loader};\nregister();\nawait import(${JSON.stringify(workerUrl.href)});\n`;
  return new Worker(bootstrap, { ...options, eval: true, execArgv: [] });
}
