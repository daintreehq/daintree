import type { PanelKind } from "../types/panel.js";
import { requalifyPersistedKind, type PersistedKindSource } from "./panelKindPersistence.js";

interface InferKindInput extends PersistedKindSource {
  kind?: PanelKind;
  browserUrl?: string;
  devCommand?: string;
  title?: string;
  cwd?: string;
  command?: string;
}

/**
 * The runtime kind a persisted panel comes back as.
 *
 * `projectId` is the project the snapshot is being restored INTO, and is what
 * re-qualifies a plugin-contributed kind against it (#12280). Omitting it is
 * safe — a project-local kind then stays in its portable form, which resolves
 * to no registry entry and so reaches the missing-plugin placeholder with its
 * record and state intact — but every restore path that knows its project
 * should pass one, because `panelKindHasPty` and `getPanelKindConfig` are keyed
 * on the fully-qualified id and would otherwise mis-classify the panel.
 */
export function inferKind(saved: InferKindInput, projectId?: string | null): PanelKind {
  // Migration: legacy persisted "agent" kind collapses into "terminal"; agent identity lives on agentId.
  if (saved.kind === "agent") return "terminal";
  // Migration: the short-lived "markdown" panel kind generalized into "file".
  if (saved.kind === "markdown") return "file";
  if (saved.kind) return requalifyPersistedKind(saved, projectId) ?? saved.kind;
  if (saved.browserUrl !== undefined) return "browser";
  if (saved.devCommand !== undefined) return "dev-preview";
  if (saved.title === "Assistant" || saved.title?.startsWith("Assistant")) return "assistant";
  if (!saved.cwd && !saved.command) return "assistant";
  return "terminal";
}
