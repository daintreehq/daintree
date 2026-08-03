import { terminalClient } from "@/clients";
import type { TerminalReconnectResult } from "@shared/types/ipc/terminal";
import { logWarn } from "@/utils/logger";

export const RECONNECT_TIMEOUT_MS = 2000;

export type ReconnectOutcome =
  | { status: "found"; terminal: NonNullable<Awaited<ReturnType<typeof terminalClient.reconnect>>> }
  | { status: "not_found" }
  /** Alive, but owned by another workspace (#11652) — the saved id must not be reused. */
  | { status: "conflict" }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

export async function reconnectWithTimeout(
  terminalId: string,
  logHydrationInfo: (message: string, context?: Record<string, unknown>) => void,
  prefetchedResult?: TerminalReconnectResult
): Promise<ReconnectOutcome> {
  // A bulk-prefetched probe result (#10390) replaces the per-panel IPC: same
  // decision logic, no round-trip inside the serialized spawn queue.
  if (prefetchedResult !== undefined) {
    if (prefetchedResult.exists && prefetchedResult.hasPty) {
      logHydrationInfo(`Reconnect prefetch hit for ${terminalId} - terminal exists in backend`);
      return { status: "found", terminal: prefetchedResult };
    }
    if (prefetchedResult.conflict) {
      logWarn(`Reconnect prefetch: terminal ${terminalId} is owned by another workspace`);
      return { status: "conflict" };
    }
    logHydrationInfo(
      `Reconnect prefetch: terminal ${terminalId} not found (exists=${prefetchedResult.exists}, hasPty=${prefetchedResult.hasPty})`
    );
    return { status: "not_found" };
  }

  try {
    logHydrationInfo(`Trying reconnect fallback for ${terminalId}`);

    const reconnectPromise = terminalClient.reconnect(terminalId);
    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("Reconnection timeout")), RECONNECT_TIMEOUT_MS)
    );

    const reconnectedTerminal = await Promise.race([reconnectPromise, timeoutPromise]);

    if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
      logHydrationInfo(
        `Reconnect fallback succeeded for ${terminalId} - terminal exists in backend but was missed by getForProject`
      );
      return { status: "found", terminal: reconnectedTerminal };
    }

    if (reconnectedTerminal?.conflict) {
      logWarn(`Reconnect fallback: terminal ${terminalId} is owned by another workspace`);
      return { status: "conflict" };
    }

    logHydrationInfo(
      `Reconnect fallback: terminal ${terminalId} not found (exists=${reconnectedTerminal?.exists}, hasPty=${reconnectedTerminal?.hasPty})`
    );
    return { status: "not_found" };
  } catch (reconnectError) {
    const isTimeout =
      reconnectError instanceof Error && reconnectError.message === "Reconnection timeout";

    if (isTimeout) {
      logWarn(`Reconnect timed out for ${terminalId} after ${RECONNECT_TIMEOUT_MS}ms`);
      return { status: "timeout" };
    }

    logWarn(`Reconnect fallback failed for ${terminalId}`, {
      error: reconnectError,
    });
    return { status: "error", error: reconnectError };
  }
}
