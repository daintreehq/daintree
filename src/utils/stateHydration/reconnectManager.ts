import { terminalClient } from "@/clients";
import { logWarn } from "@/utils/logger";

const RECONNECT_TIMEOUT_MS = 2000;

export type ReconnectOutcome =
  | { status: "found"; terminal: NonNullable<Awaited<ReturnType<typeof terminalClient.reconnect>>> }
  | { status: "not_found" }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

export async function reconnectWithTimeout(
  terminalId: string,
  logHydrationInfo: (message: string, context?: Record<string, unknown>) => void
): Promise<ReconnectOutcome> {
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
