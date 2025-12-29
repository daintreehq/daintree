import { z } from "zod";
import { notesClient } from "@/clients/notesClient";
import { useTerminalStore } from "@/store";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

export function registerNotesActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("notes.create", () => ({
    id: "notes.create",
    title: "Notes...",
    description: "Open the notes palette to browse and manage notes",
    category: "notes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:open-notes-palette"));
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

  const deleteArgsSchema = z.object({
    notePath: z.string(),
    panelId: z.string(),
    noteTitle: z.string().optional(),
  });
  type DeleteArgs = z.infer<typeof deleteArgsSchema>;

  actions.set("notes.delete", () => ({
    id: "notes.delete",
    title: "Delete Note",
    description: "Delete a note file and close its panel",
    category: "notes",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: deleteArgsSchema,
    run: async (args: unknown) => {
      const { notePath, panelId, noteTitle } = args as DeleteArgs;

      const displayTitle = noteTitle || "this note";
      const confirmed = window.confirm(
        `Delete "${displayTitle}"?\n\nThis action cannot be undone.`
      );

      if (!confirmed) {
        return { cancelled: true };
      }

      try {
        await notesClient.delete(notePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          const message = error instanceof Error ? error.message : "Unknown error";
          window.alert(`Failed to delete note: ${message}`);
          throw new Error(message);
        }
      }

      useTerminalStore.getState().removeTerminal(panelId);
      return { success: true };
    },
  }));

  const revealArgsSchema = z.object({
    notePath: z.string(),
  });
  type RevealArgs = z.infer<typeof revealArgsSchema>;

  actions.set("notes.reveal", () => ({
    id: "notes.reveal",
    title: "Reveal in Notes Palette",
    description: "Open the notes palette with this note highlighted",
    category: "notes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: revealArgsSchema,
    run: async (args: unknown) => {
      const { notePath } = args as RevealArgs;
      window.dispatchEvent(
        new CustomEvent("canopy:open-notes-palette", {
          detail: { highlightNotePath: notePath },
        })
      );
    },
  }));
}
