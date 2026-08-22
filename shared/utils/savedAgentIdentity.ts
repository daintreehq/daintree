import type { PanelKind } from "../types/panel.js";

/** The persisted fields that can name the agent a panel was launched under. */
export interface SavedAgentIdentityInput {
  launchAgentId?: string;
  /** Legacy marker from before agents were identified by id. */
  type?: string;
  /** Legacy field the launch id superseded. */
  agentId?: string;
  title?: string;
  kind?: string;
}

export function resolveAgentId(
  primaryAgentId: string | undefined,
  fallbackAgentId?: string | undefined
): string | undefined {
  if (primaryAgentId) return primaryAgentId;
  if (fallbackAgentId) return fallbackAgentId;
  return undefined;
}

export function inferAgentIdFromTitle(
  title: string | undefined,
  kind: PanelKind | undefined,
  existingAgentId: string | undefined,
  _terminalId: string,
  _logContext: string
): string | undefined {
  if (existingAgentId) return existingAgentId;
  // Only recover agent identity from persisted state that was *itself* written
  // as an agent panel — the legacy `kind: "agent"` marker. Plain terminals with
  // incidental "claude" or "gemini" in their user-assigned title must not be
  // silently promoted to agent terminals during respawn (that would regenerate
  // a Claude launch command and take over the user's renamed shell).
  if (kind !== "agent") return undefined;

  const titleLower = (title ?? "").toLowerCase();
  if (titleLower.includes("claude")) return "claude";
  if (titleLower.includes("antigravity")) return "antigravity";
  if (titleLower.includes("gemini")) return "gemini";
  if (titleLower.includes("codex")) return "codex";
  if (titleLower.includes("opencode")) return "opencode";

  return undefined;
}

/**
 * Resolve the agent identity a respawn will actually launch under: the legacy
 * on-disk `agentId`/`type` migration plus the title-based recovery for snapshots
 * written under the old `kind: "agent"` marker. Shared with restore's
 * resume-latest election (#11461) so slot eligibility can never disagree with the
 * command the respawn goes on to build. Pure — safe to call in a pre-pass.
 *
 * Lives in `shared/` because main counts the agent panels a project would bring
 * back (#11801) and has to reach the same answer restore does. A row that
 * announces "2 agents will resume" from a rule the respawn doesn't share is
 * making a promise nothing keeps — and the legacy spellings are exactly what
 * the oldest rows, the ones that most need the mark, are written in.
 */
export function resolveRespawnAgentId(
  saved: SavedAgentIdentityInput,
  kind: PanelKind | undefined
): string | undefined {
  const savedLaunchAgentId =
    saved.launchAgentId ?? (saved.type === "claude" ? "claude" : saved.agentId);
  return inferAgentIdFromTitle(
    saved.title,
    kind,
    resolveAgentId(savedLaunchAgentId),
    // The persisted id and a log label, neither of which the pure resolution
    // reads — kept in the signature so the renderer's call sites are unchanged.
    "",
    "Respawn"
  );
}
