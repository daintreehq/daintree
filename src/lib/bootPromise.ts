import type { BootResult } from "@shared/types/ipc/app";
import { isElectronAvailable } from "@/hooks/useElectron";
import { markRendererPerformance } from "@/utils/performance";
import { PERF_MARKS } from "@shared/perf/marks";
import { logError } from "@/utils/logger";

/**
 * React's `use()` hook reads these non-standard fields off a thenable
 * synchronously when they are present, returning the value without suspending
 * for a microtask. Annotating the promise the moment it settles lets the first
 * `App` render read an already-resolved boot payload without a Suspense tick.
 * This mirrors the convention SWR/React Query/Relay rely on: the fields are not
 * a public React API but have been stable since the Suspense data-fetching RFC.
 */
type ReactThenable<T> = Promise<T> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: T;
  reason?: unknown;
};

function annotate<T>(promise: Promise<T>): Promise<T> {
  const thenable = promise as ReactThenable<T>;
  thenable.status = "pending";
  // The rejection handler also marks the promise as handled, so a boot IPC
  // failure never surfaces as an unhandled rejection.
  thenable.then(
    (value) => {
      thenable.status = "fulfilled";
      thenable.value = value;
    },
    (reason) => {
      thenable.status = "rejected";
      thenable.reason = reason;
    }
  );
  return promise;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export type SafeBootResult = { ok: true; result: BootResult } | { ok: false; error: Error };

let bootPromise: Promise<BootResult> | null = null;
let safeBootPromise: Promise<SafeBootResult> | null = null;

/**
 * Fire `app:boot` exactly once and cache the in-flight promise. Called at
 * module-eval time from `main.tsx` so the IPC round-trip overlaps React parse
 * and the first commit instead of waiting for a mount effect (#8820). The
 * promise reference is stable across renders, which is mandatory for `use()` —
 * a fresh reference would re-suspend the consumer on every render.
 */
export function getBootPromise(): Promise<BootResult> {
  if (bootPromise) return bootPromise;

  if (!isElectronAvailable()) {
    bootPromise = annotate(Promise.reject(new Error("Electron unavailable")));
    return bootPromise;
  }

  markRendererPerformance(PERF_MARKS.RENDERER_APP_BOOT_IPC_SENT);
  try {
    bootPromise = annotate(window.electron.app.boot());
  } catch (error) {
    // This runs at module-eval time, before `bootstrap().catch()` is wired and
    // outside any React error boundary — a synchronous throw from a partially
    // initialized bridge would otherwise be uncaught. Convert it to a rejected
    // promise so `getSafeBootPromise` can degrade it to an `{ ok: false }`
    // sentinel.
    bootPromise = annotate(Promise.reject(toError(error)));
  }
  return bootPromise;
}

/**
 * `use()`-friendly wrapper: never rejects, so a boot IPC failure degrades to an
 * `{ ok: false }` sentinel that lets the app render its cold-start chrome
 * instead of throwing into an error boundary. Boot failure is a graceful
 * degradation, not an unrecoverable render error.
 */
export function getSafeBootPromise(): Promise<SafeBootResult> {
  if (safeBootPromise) return safeBootPromise;
  safeBootPromise = annotate(
    getBootPromise().then(
      (result): SafeBootResult => ({ ok: true, result }),
      (error): SafeBootResult => {
        const wrapped = toError(error);
        // Tier 0 — silent log: boot failure degrades gracefully (the app still
        // renders its cold-start chrome and falls back to live `app:hydrate`),
        // so there is no user-facing action to surface, but the cause is worth
        // a breadcrumb.
        logError("Failed to fetch boot payload", wrapped);
        return { ok: false, error: wrapped };
      }
    )
  );
  return safeBootPromise;
}

/** Test-only: clear the module-scope cache so each case starts fresh. */
export function resetBootPromiseForTests(): void {
  bootPromise = null;
  safeBootPromise = null;
}

if (import.meta.hot) {
  // HMR re-evaluates this module while the V8 context stays alive, so the
  // cached promises must be cleared or `use()` would read a stale payload from
  // a prior dev session. A crash-resolve reboot uses `webContents.reload()`,
  // which destroys the context outright — no manual reset needed there.
  import.meta.hot.dispose(() => {
    bootPromise = null;
    safeBootPromise = null;
  });
}
