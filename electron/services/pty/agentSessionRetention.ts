// eager-import-allow: reads the agent-session retention setting via store.get synchronously
import { store } from "../../store.js";
import { DEFAULT_RETENTION_DAYS } from "./agentSessionHistory.js";
import type { AgentSessionRetentionDays } from "../../../shared/types/ipc/agentSessionHistory.js";

/**
 * Read the current agent resume-journal retention window from the store, fresh
 * on every call — the user may change it mid-session (mirrors
 * `PeriodicCleanupService`'s "re-read retention each pass"). Kept out of the
 * pure `agentSessionHistory.ts` module so that module stays electron-free and
 * synchronously unit-testable; every persist call site funnels through here.
 *
 * Defensive by design: this is called inline on best-effort journaling paths
 * (`persistCloseRecord`, shutdown journaling), evaluated as a function argument
 * *before* `persistAgentSession`. A store-read failure (corrupt config, etc.)
 * must degrade to the default window, never throw and abort journaling.
 */
export function getAgentSessionRetentionDays(): AgentSessionRetentionDays {
  try {
    return store.get("agentSessionHistory")?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}
