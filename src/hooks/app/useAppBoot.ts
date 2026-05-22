import { use } from "react";
import { getSafeBootPromise, type SafeBootResult } from "@/lib/bootPromise";

export type { SafeBootResult };

/**
 * Reads the batched `app:boot` payload that `bootPromise` fires at module-eval
 * time (#8820). `use()` suspends the consumer until the IPC settles and reads
 * the cached, pre-annotated promise synchronously once it has — so when the
 * round-trip beats first render there is no Suspense tick.
 *
 * The promise never rejects (see `getSafeBootPromise`): a boot failure resolves
 * to `{ ok: false }` so the app still renders its cold-start chrome rather than
 * throwing into an error boundary. The stable module-scope promise also makes
 * Strict Mode's double-render harmless — it reads the same reference and never
 * issues a second IPC call.
 */
export function useAppBoot(): SafeBootResult {
  return use(getSafeBootPromise());
}
