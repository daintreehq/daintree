/**
 * Imports the WHOLE scenario matrix with `module.registerHooks` and
 * `module.register` instrumented, and prints what registered during that
 * import as a single JSON line on stdout.
 *
 * Not a test file — `moduleHookHygiene.test.ts` spawns this under `tsx`. It has
 * to be a separate process for two reasons. Vitest sets `VITEST`, and every
 * fixture skips its hook registration when that is set, so an in-process probe
 * would measure nothing and pass forever. And the instrumentation has to be in
 * place BEFORE the matrix is imported, which a static `import` of `../scenarios`
 * could not guarantee — hence the dynamic import below.
 *
 * The probe also proves itself: after the matrix is loaded it registers one
 * inert identity hook through the same `node:module` default export the
 * fixtures use, and reports whether the counter saw it. A probe that patched
 * the wrong object would otherwise report a clean matrix forever, which is the
 * exact defect class this file exists to catch.
 *
 * Usage: tsx moduleHookProbe.ts
 */
import nodeModule from "node:module";

interface Registration {
  /** `registerHooks` or `register`. */
  api: string;
  /** First stack frame outside this probe — the file that registered. */
  origin: string;
}

const registrations: Registration[] = [];

type HookFn = (...args: unknown[]) => unknown;
type ModuleApis = Record<string, unknown>;

const moduleApis = nodeModule as unknown as ModuleApis;
const patchedApis: string[] = [];

/** The frame that called into `node:module`, with this probe's own frames dropped. */
function originOf(): string {
  const frames = (new Error("module hook registration").stack ?? "").split("\n").slice(1);
  for (const frame of frames) {
    if (frame.includes("moduleHookProbe")) continue;
    return frame.trim();
  }
  return "unknown";
}

for (const api of ["registerHooks", "register"]) {
  const original = moduleApis[api];
  if (typeof original !== "function") continue;
  patchedApis.push(api);
  moduleApis[api] = function patched(this: unknown, ...args: unknown[]): unknown {
    registrations.push({ api, origin: originOf() });
    return (original as HookFn).apply(this, args);
  };
}

async function main(): Promise<void> {
  // Dynamic on purpose: a static import would be hoisted above the patching.
  const matrix = (await import("../scenarios")) as { allScenarios: readonly unknown[] };
  const importTime = registrations.slice();

  // Self-check. `registerHooks` is synchronous and in-thread, so an identity
  // resolve hook is inert; `register` is the fallback on a Node without it.
  const before = registrations.length;
  if (typeof moduleApis["registerHooks"] === "function") {
    (moduleApis["registerHooks"] as HookFn)({
      resolve(specifier: string, context: unknown, next: HookFn) {
        return next(specifier, context);
      },
    });
  } else if (typeof moduleApis["register"] === "function") {
    (moduleApis["register"] as HookFn)(
      "data:text/javascript,export async function resolve(s,c,n){return n(s,c);}"
    );
  }
  const selfCheckObserved = registrations.length > before;

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      patchedApis,
      scenarioCount: matrix.allScenarios.length,
      selfCheckObserved,
      registrations: importTime,
    })}\n`
  );
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    process.exit(1);
  }
);
