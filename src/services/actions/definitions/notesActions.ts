import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { notesClient } from "@/clients/notesClient";
import { useTerminalStore } from "@/store/terminalStore";
import { useNotesStore } from "@/store/notesStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export function registerNotesActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("notes.create", () => ({
    id: "notes.create",
    title: "Create Note",
    description: "Create a new notes panel",
    category: "notes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ title: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { title } = (args as { title?: string } | undefined) ?? {};
      const noteTitle = title || `Note ${new Date().toLocaleDateString()}`;
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;

      try {
        const noteContent = await notesClient.create(noteTitle, "project");

        await useTerminalStore.getState().addTerminal({
          kind: "notes",
          title: noteContent.metadata.title,
          cwd: "",
          worktreeId: activeWorktreeId ?? undefined,
          notePath: noteContent.path,
          noteId: noteContent.metadata.id,
          scope: noteContent.metadata.scope,
          createdAt: noteContent.metadata.createdAt,
        });

        useNotesStore.getState().refresh();
      } catch (error) {
        console.error("Failed to create note:", error);
      }
    },
  }));

  actions.set("notes.openPalette", () => ({
    id: "notes.openPalette",
    title: "Open Notes Palette",
    description: "Open the notes palette to browse and select notes",
    category: "notes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:open-notes-palette"));
    },
  }));
}
