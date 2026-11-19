import { store } from "../../store.js";
import {
  admitRestoredAssistantPanes,
  attachAssistantPaneCreationPersistence,
  type AssistantPaneCreationPersistence,
} from "./assistantPaneCreations.js";

/** Where an Assistant's kept pane creations live between runs (#16845). */
export const storeAssistantPaneCreationPersistence: AssistantPaneCreationPersistence = {
  load: () => store.get("assistantPaneCreations"),
  save: (records) => store.set("assistantPaneCreations", records),
};

/** Keep an Assistant's pane creations on disk from here on, loading what an earlier run left. */
export function attachAssistantPaneCreationStore(): void {
  attachAssistantPaneCreationPersistence(storeAssistantPaneCreationPersistence);
}

/**
 * Hand the panes a hydrate of `workspaceId` restores to the kept records, once
 * the lane pointers this launch read say which conversations can still resume.
 * A restored project can hydrate before the MCP server starts, so this attaches
 * the disk itself.
 */
export async function admitRestoredAssistantPanesFromStore(
  workspaceId: string,
  panes: ReadonlyArray<{ id: string; spawnedBy?: unknown }>
): Promise<void> {
  attachAssistantPaneCreationStore();
  const { getPendingHelpHibernationStore } = await import("../PendingHelpHibernationStore.js");
  const pointers = getPendingHelpHibernationStore();
  await pointers.load();
  const { getPtyClient } = await import("../../window/serviceRefs.js");
  admitRestoredAssistantPanes(
    workspaceId,
    panes,
    pointers.loadedConversationOwnershipIds(),
    (id) => {
      const pty = getPtyClient();
      return pty?.hasTerminal(id) === true ? pty.getTerminalProjectId(id) : null;
    }
  );
}
