export function getNoteDisplayTitle(note: { title: string; preview: string }): string {
  return note.title.trim() || note.preview.trim() || "Untitled";
}
