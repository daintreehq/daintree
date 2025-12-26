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
}
