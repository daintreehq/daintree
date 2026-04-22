import type { PanelKind } from "../types/panel.js";

interface InferKindInput {
  kind?: PanelKind;
  browserUrl?: string;
  devCommand?: string;
  title?: string;
  cwd?: string;
  command?: string;
}

export function inferKind(saved: InferKindInput): PanelKind {
  // Migration: legacy persisted "agent" kind collapses into "terminal"; agent identity lives on agentId.
  if (saved.kind === "agent") return "terminal";
  if (saved.kind) return saved.kind;
  if (saved.browserUrl !== undefined) return "browser";
  if (saved.devCommand !== undefined) return "dev-preview";
  if (saved.title === "Assistant" || saved.title?.startsWith("Assistant")) return "assistant";
  if (!saved.cwd && !saved.command) return "assistant";
  return "terminal";
}
