import type {
  AgentSessionCloseCause,
  AgentSessionRecord,
} from "../../../shared/types/ipc/agentSessionHistory.js";
import { TRASH_TTL_MS } from "../../../shared/config/trash.js";
import { parseE2ETimerOverrideMs } from "../../../shared/config/e2eTimerOverrides.js";

/**
 * Host-side trash TTL. An unpackaged E2E launch may shorten it (the renderer
 * gets the same value through the preload) so a spec can observe expiry
 * without sleeping through the real 20 s window.
 */
export function resolveTrashTtlMs(): number {
  if (process.env.DAINTREE_E2E_MODE === "1" && process.env.DAINTREE_IS_PACKAGED === "0") {
    const override = parseE2ETimerOverrideMs(process.env.DAINTREE_E2E_TRASH_TTL_MS);
    if (override !== null) return override;
  }
  return TRASH_TTL_MS;
}

/** A terminal as a close path read it before ending it. */
export interface ClosingTerminal {
  id: string;
  spawnedAt?: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
}

/**
 * What ended a pane, from its terminal as read before the kill. One in the
 * trash was closed by the user, whatever then ended its process: the trash's
 * own expiry, a removal from the trash, or a quit or project close inside its
 * window. Any other pane ended for the closing path's own reason.
 */
export function attributeClose(
  terminal: ClosingTerminal | null | undefined,
  cause: Exclude<AgentSessionCloseCause, "user">,
  trashTtlMs: number = resolveTrashTtlMs()
): Pick<AgentSessionRecord, "closedBy" | "trash"> {
  if (
    terminal?.isTrashed === true &&
    typeof terminal.trashExpiresAt === "number" &&
    typeof terminal.spawnedAt === "number"
  ) {
    return {
      closedBy: "user",
      trash: {
        terminalId: terminal.id,
        spawnedAt: terminal.spawnedAt,
        expiresAt: terminal.trashExpiresAt,
        closedAt: terminal.trashExpiresAt - trashTtlMs,
      },
    };
  }
  return { closedBy: cause };
}
