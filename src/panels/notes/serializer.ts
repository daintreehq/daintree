import type { NotesPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export function serializeNotes(t: NotesPanelData): Partial<PanelSnapshot> {
  return {
    ...(t.notePath != null && { notePath: t.notePath }),
    ...(t.noteId != null && { noteId: t.noteId }),
    ...(t.scope != null && { scope: t.scope }),
    ...(t.createdAt !== undefined && { createdAt: t.createdAt }),
  };
}
