import type { TerminalInstance } from "@shared/types/panel";
import type { TerminalSnapshot } from "@shared/types/project";

export function serializeNotes(t: TerminalInstance): Partial<TerminalSnapshot> {
  return {
    ...(t.notePath != null && { notePath: t.notePath }),
    ...(t.noteId != null && { noteId: t.noteId }),
    ...(t.scope != null && { scope: t.scope }),
    ...(t.createdAt !== undefined && { createdAt: t.createdAt }),
  };
}
