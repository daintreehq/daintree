import {
  PolicyRegistry,
  gateAllowsText,
  questionExpiryPolicy,
  type WorkflowGate,
} from "@daintreehq/decisions-client";
import type {
  DecisionsPolicy,
  DecisionsSettings,
  DecisionsWorkflowGate,
} from "../../../shared/types/decisions.js";

export const DESIGN_REVIEW_FINAL_GATE_ID = "design-review/final";

/**
 * The final screenshots of a design review: only the person may answer, the
 * answer is Approve or Reject and nothing else, and it binds to the images
 * attached, so `get_decision` can say whether the person reviewed exactly
 * those. A workflow continues only on a human approval whose reviewed
 * digests match; changed images are a new question.
 */
const DESIGN_REVIEW_FINAL: WorkflowGate = {
  gateId: DESIGN_REVIEW_FINAL_GATE_ID,
  minRequirement: "human-required",
  policyVersion: 1,
  choices: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ],
  // Said outright: with text allowed, the library takes a note with no choice as an answer.
  allowText: false,
  bindArtifacts: true,
  // No `expiryMs`: naming the gate never changes how long a question waits, so
  // the default expiry Settings saves applies under it too.
};

/**
 * Every gate Daintree trusts. Questions name a gate by id; only this list
 * defines one, and nothing reachable from an agent or a renderer adds to it.
 */
const TRUSTED_WORKFLOW_GATES: readonly WorkflowGate[] = [DESIGN_REVIEW_FINAL];

/** The saved settings the trusted policy is made from. */
export type PolicySettings = Pick<DecisionsSettings, "proxyAllowlisted" | "defaultQuestionExpiryMs">;

/**
 * The policy an enabled lifetime asks every question under: the trusted
 * gates, the proxy allowlist and the default expiry as saved. The registry
 * copies each gate, so nothing holding the definitions above can change one
 * after registration.
 */
export function createTrustedPolicy(settings: PolicySettings): PolicyRegistry {
  const policy = new PolicyRegistry({
    proxyAllowlisted: settings.proxyAllowlisted,
    defaultQuestionExpiryMs: settings.defaultQuestionExpiryMs,
  });
  for (const gate of TRUSTED_WORKFLOW_GATES) policy.register(gate);
  return policy;
}

/** The trusted gates as Settings shows them: copies, so nothing read can reach the registry. */
export function describeTrustedGates(): DecisionsWorkflowGate[] {
  return TRUSTED_WORKFLOW_GATES.map((gate) => ({
    id: gate.gateId,
    requirement: gate.minRequirement,
    choices: (gate.choices ?? []).map(({ id, label }) => ({ id, label })),
    allowsText: gateAllowsText(gate),
    bindsAttachments: gate.bindArtifacts === true,
  }));
}

/** The policy as Settings reads it, for these settings, at this revision. */
export function decisionsPolicyOf(settings: PolicySettings, revision: number): DecisionsPolicy {
  // The library's own rule for a question with no origin gate, so what
  // Settings says is what the registry does.
  const expiry = questionExpiryPolicy(settings.defaultQuestionExpiryMs);
  return {
    gates: describeTrustedGates(),
    proxyAllowlisted: settings.proxyAllowlisted,
    defaultQuestionExpiryMs: expiry.defaultMs,
    maxQuestionExpiryMs: expiry.maxMs,
    revision,
  };
}
