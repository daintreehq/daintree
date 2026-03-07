import { z } from "zod";
import { notesClient } from "@/clients/notesClient";
import { useTerminalStore } from "@/store";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

export function registerNotesActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("notes.create", () => ({
    id: "notes.create",
    title: "Create Note",
    description:
      "Create a new note. If title and content are provided, creates programmatically. Otherwise opens the notes palette.",
    category: "notes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        title: z
          .string()
          .optional()
          .describe("Note title. If omitted, opens the notes palette instead."),
        content: z.string().optional().describe("Initial note content (markdown)"),
        scope: z.enum(["worktree", "project"]).optional().describe("Note scope (default: project)"),
        worktreeId: z.string().optional().describe("Worktree ID (required if scope is worktree)"),
      })
      .optional(),
    run: async (args: unknown) => {
      const {
        title,
        content,
        scope: noteScope,
        worktreeId,
      } = (args as
        | { title?: string; content?: string; scope?: "worktree" | "project"; worktreeId?: string }
        | undefined) ?? {};

      if (!title) {
        window.dispatchEvent(new CustomEvent("canopy:open-notes-palette"));
        return;
      }

      const note = await notesClient.create(title, noteScope ?? "project", worktreeId);
      if (content) {
        await notesClient.write(note.path, content, note.metadata);
      }
      return { path: note.path, title: note.metadata.title, id: note.metadata.id };
    },
  }));

  actions.set("notes.list", () => ({
    id: "notes.list",
    title: "List Notes",
    description: "List all notes with metadata and preview",
    category: "notes",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await notesClient.list();
    },
  }));

  actions.set("notes.read", () => ({
    id: "notes.read",
    title: "Read Note",
    description: "Read a note's full content by path",
    category: "notes",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      notePath: z.string().describe("Path to the note file"),
    }),
    run: async (args: unknown) => {
      const { notePath } = args as { notePath: string };
      return await notesClient.read(notePath);
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
    notePath: z.string().describe("Path to the note file (from notes.list)"),
    panelId: z
      .string()
      .optional()
      .describe("Panel ID to close (optional — if omitted, finds the panel by notePath)"),
    noteTitle: z.string().optional().describe("Note title for confirmation prompt"),
  });
  type DeleteArgs = z.infer<typeof deleteArgsSchema>;

  actions.set("notes.delete", () => ({
    id: "notes.delete",
    title: "Delete Note",
    description: "Delete a note file and close its panel if open",
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

      // Close the panel if we have or can find its ID
      const targetPanelId =
        panelId ??
        useTerminalStore
          .getState()
          .terminals.find((t) => t.kind === "notes" && t.notePath === notePath)?.id;
      if (targetPanelId) {
        useTerminalStore.getState().removeTerminal(targetPanelId);
      }
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
