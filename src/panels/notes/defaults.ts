import type { NotesPanelData } from "@shared/types/panel";
import type { NotesPanelOptions } from "@shared/types/addPanelOptions";

export function createNotesDefaults(options: NotesPanelOptions): Partial<NotesPanelData> {
  return {
    ...(options.notePath && { notePath: options.notePath }),
    ...(options.noteId && { noteId: options.noteId }),
    scope: options.scope ?? "project",
    createdAt: options.createdAt ?? Date.now(),
  };
}
