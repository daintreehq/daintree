/**
 * A persona the person gave an assistant or an agent (#16213): what it is
 * called and the emoji it wears. Display only — routing, agent ids and terminal
 * ids never read it, and an absent field means the surface's own label.
 */
export interface DisplayIdentity {
  name?: string;
  emoji?: string;
}

/** The installation's assistant personas: the one global run, and one per project. */
export interface AssistantIdentities {
  global: DisplayIdentity;
  /** Keyed by project id; a project without an entry shows today's label. */
  projects: Record<string, DisplayIdentity>;
}

export type AssistantIdentityScope = { kind: "global" } | { kind: "project"; projectId: string };

export interface SetAssistantIdentityRequest {
  scope: AssistantIdentityScope;
  /** Replaces the scope's persona; an empty one clears it. */
  identity: DisplayIdentity;
}
