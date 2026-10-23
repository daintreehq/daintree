import type {
  PluginApplicationDescriptor,
  ProjectApplicationReason,
  ProjectApplicationState,
  ProjectApplicationStatus,
} from "../types/plugin.js";

/** One discovered project plugin that declares an application, as its controller sees it. */
export interface ProjectApplicationCandidate {
  manifestId: string;
  application: PluginApplicationDescriptor;
  /** The instance key it is loaded under, when it is loaded. */
  instanceId?: string;
  /** Waiting for the user to turn it on. */
  staged: boolean;
  muted: boolean;
  /** Its last load was refused, or the loaded instance recorded a load or activation error. */
  loadFailed: boolean;
  /** Its `engines.daintree` range does not admit the running Daintree. */
  engineIncompatible: boolean;
}

export interface ProjectApplicationInput {
  candidates: readonly ProjectApplicationCandidate[];
  /** Whether the project's plugins may run at all. */
  trusted: boolean;
  /** INSTANCE key of the plugin holding the project's Home slot, or `null` for none. */
  homeHeldBy: string | null;
}

function state(
  candidate: ProjectApplicationCandidate,
  status: ProjectApplicationStatus,
  extra: { reason?: ProjectApplicationReason; candidates?: string[]; heldBy?: string } = {}
): ProjectApplicationState {
  return {
    status,
    ownerId: candidate.manifestId,
    ...(candidate.instanceId !== undefined ? { instanceId: candidate.instanceId } : {}),
    application: structuredClone(candidate.application),
    ...extra,
    fallback: status === "active" ? null : "standard-workspace",
  };
}

/**
 * Resolve a project's application from its controller's view of the plugins
 * that declare one (#14097). Pure and order-independent: the same candidates
 * give the same state whatever order they were discovered in.
 *
 * Reads nothing and writes nothing — no preference, route, surface answer or
 * tour progress — so a user's own choices stay where they are whatever the
 * application's state, and a disabled or missing owner leaves the standard
 * workspace exactly as the user left it.
 *
 * Two declarations are an authoring error with no right answer, so neither is
 * applied: switching one off must not silently promote the other.
 */
export function resolveProjectApplication(
  input: ProjectApplicationInput
): ProjectApplicationState | null {
  const ranked = [...input.candidates].sort((a, b) =>
    a.manifestId < b.manifestId ? -1 : a.manifestId > b.manifestId ? 1 : 0
  );
  const owner = ranked[0];
  if (owner === undefined) return null;
  if (ranked.length > 1) {
    return state(owner, "unavailable", {
      reason: "owner-ambiguous",
      candidates: ranked.map((candidate) => candidate.manifestId),
    });
  }
  if (!input.trusted) return state(owner, "disabled", { reason: "untrusted" });
  if (owner.muted) return state(owner, "disabled", { reason: "muted" });
  if (owner.staged) return state(owner, "disabled", { reason: "staged" });
  if (owner.engineIncompatible) return state(owner, "unavailable", { reason: "engine-incompatible" });
  if (owner.loadFailed) return state(owner, "unavailable", { reason: "load-failed" });
  if (owner.instanceId === undefined) return state(owner, "loading");
  if (
    owner.application.destination === "home" &&
    input.homeHeldBy !== null &&
    input.homeHeldBy !== owner.instanceId
  ) {
    return state(owner, "replaced", { heldBy: input.homeHeldBy });
  }
  return state(owner, "active");
}
