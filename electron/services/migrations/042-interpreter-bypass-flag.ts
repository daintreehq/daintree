import type { Migration } from "../StoreMigrations.js";

const RETIRED_FLAG = "--auto_run";
const CURRENT_FLAG = "--dangerously-bypass-approvals-and-sandbox";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Replace Open Interpreter's bypass flag where Daintree stored its old default
 * (issue #15567). `--auto_run` belonged to the Python program; the current Rust
 * product rejects it, so an agent launched with skip-permissions on would exit
 * at once. Settings seed `dangerousArgs` from the default, which is how the old
 * value reached the store. A value the user wrote themselves is left alone.
 *
 * Self-contained on purpose: a migration is a snapshot of the shape it moves.
 */
export const migration042: Migration = {
  version: 42,
  description: "Replace Open Interpreter's retired Python bypass flag (issue #15567)",
  up: (store) => {
    const agentSettings = store.get("agentSettings") as unknown;
    if (!isRecord(agentSettings) || !isRecord(agentSettings.agents)) return;
    const entry = agentSettings.agents.interpreter;
    if (!isRecord(entry) || typeof entry.dangerousArgs !== "string") return;
    if (entry.dangerousArgs.trim() !== RETIRED_FLAG) return;

    store.set("agentSettings", {
      ...agentSettings,
      agents: { ...agentSettings.agents, interpreter: { ...entry, dangerousArgs: CURRENT_FLAG } },
    } as never);
    console.log("[Migration 042] Replaced Open Interpreter's retired bypass flag");
  },
};
