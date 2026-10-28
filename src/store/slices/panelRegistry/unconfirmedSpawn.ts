import type { TerminalReconnectResult } from "@shared/types/ipc/terminal";
import { waitForHostConnected } from "@/store/hostConnectionStore";
import { isClientAppError } from "@/utils/clientAppError";
import { isUnknownOutcomeError } from "@/utils/resolveUnknownOutcome";

/**
 * Asked again while the host doesn't list the terminal, from the moment the
 * link is back: about a minute in all. The host prepares a spawn before it
 * starts one, and admission alone lets one through a second past a burst of
 * six, with up to fifty waiting, so a launch from a large recipe can still be
 * on its way well after the first answer comes back.
 */
const ABSENT_RECHECK_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Spawns whose answer was lost with the link and are still being checked,
 * keyed by terminal id, each held by the check that marked it. The host may be
 * running the terminal behind them, so resync leaves these ids alone until the
 * check settles.
 */
const unconfirmed = new Map<string, symbol>();

/**
 * The link wrote the spawn to the host and closed before the answer came back,
 * so the host may well have started it. One still in the Shell's queue
 * (HOST_DISCONNECTED) never left, and fails as it is.
 */
export function isLostSpawnReply(error: unknown): boolean {
  return isClientAppError(error) && error.code === "OUTCOME_UNKNOWN";
}

export function isSpawnUnconfirmed(id: string): boolean {
  return unconfirmed.has(id);
}

/**
 * Held until the returned release runs. A later launch under the same id takes
 * the mark over, and an earlier check settling never releases it.
 */
export function markSpawnUnconfirmed(id: string): () => void {
  const holder = Symbol(id);
  unconfirmed.set(id, holder);
  return () => {
    if (unconfirmed.get(id) === holder) unconfirmed.delete(id);
  };
}

export type SpawnOnHost =
  { status: "started"; record: TerminalReconnectResult } | { status: "absent" };

export interface FindSpawnOnHostOptions {
  probe?: (id: string) => Promise<TerminalReconnectResult>;
  waitForConnected?: () => Promise<void>;
  recheckDelaysMs?: readonly number[];
}

/**
 * What became of a spawn whose answer never came: waits for the link, then
 * asks the host about the terminal by the id this view gave it. A link that
 * drops again mid-check is waited out rather than read as an answer. Absent
 * only once the host has gone on not listing it; any other failure to ask
 * throws.
 */
export async function findSpawnOnHost(
  id: string,
  options: FindSpawnOnHostOptions = {}
): Promise<SpawnOnHost> {
  const probe =
    options.probe ?? ((terminalId: string) => window.electron.terminal.reconnect(terminalId));
  const waitForConnected = options.waitForConnected ?? (() => waitForHostConnected());
  const delays = options.recheckDelaysMs ?? ABSENT_RECHECK_DELAYS_MS;

  for (let attempt = 0; ; attempt++) {
    let record: TerminalReconnectResult;
    for (;;) {
      await waitForConnected();
      try {
        record = await probe(id);
        break;
      } catch (error) {
        if (!isUnknownOutcomeError(error)) throw error;
      }
    }
    if (record.exists) return { status: "started", record };
    // Live but owned by another workspace: not this launch.
    if (record.conflict || attempt >= delays.length) return { status: "absent" };
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}
