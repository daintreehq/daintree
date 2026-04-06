import type { PanelKind } from "../types/panel.js";

interface InferKindInput {
  kind?: PanelKind;
  browserUrl?: string;
  notePath?: string;
  noteId?: string;
  devCommand?: string;
  title?: string;
  cwd?: string;
  command?: string;
}

export function inferKind(saved: InferKindInput): PanelKind {
  if (saved.kind) return saved.kind;
  if (saved.browserUrl !== undefined) return "browser";
  if (saved.notePath !== undefined || saved.noteId !== undefined) return "notes";
  if (saved.devCommand !== undefined) return "dev-preview";
  if (saved.title === "Assistant" || saved.title?.startsWith("Assistant")) return "assistant";
  if (!saved.cwd && !saved.command) return "assistant";
  return "terminal";
}
