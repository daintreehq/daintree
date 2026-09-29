import type { Migration } from "../StoreMigrations.js";

/**
 * Before schema v30 the assistant's `modelId` used "" both for "never chosen"
 * and for an explicit "Default (CLI default)" pick, so the two can't be told
 * apart. Every "" becomes absent, which now reads as the agent's recommended
 * assistant model; a concrete model ID the user chose is kept as-is.
 */
export const migration030: Migration = {
  version: 30,
  description: "Move the assistant's unset model onto the agent's recommended default",
  up: (store) => {
    const helpAssistant = store.get("helpAssistant") as Record<string, unknown> | undefined;
    if (!helpAssistant || typeof helpAssistant !== "object") return;
    if (typeof helpAssistant.modelId !== "string" || helpAssistant.modelId.trim() !== "") return;

    const next = { ...helpAssistant };
    delete next.modelId;
    store.set("helpAssistant", next as never);
  },
};
