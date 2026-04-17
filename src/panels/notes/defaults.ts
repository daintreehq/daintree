import type { TerminalInstance } from "@shared/types/panel";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";

export function createNotesDefaults(options: AddPanelOptions): Partial<TerminalInstance> {
  return {
    notePath: ("notePath" in options ? options.notePath : undefined) ?? "",
    noteId: ("noteId" in options ? options.noteId : undefined) ?? "",
    scope: ("scope" in options ? options.scope : undefined) ?? "project",
    createdAt: ("createdAt" in options ? options.createdAt : undefined) ?? Date.now(),
  };
}
