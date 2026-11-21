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
export type PolicySettings = Pick<DecisionsSettings, "defaultQuestionExpiryMs">;

export interface TrustedPolicyOptions extends PolicySettings {
  /**
   * Whether a question with no gate may take a proxy answer when its agent
   * allows one: only while the owner's decision model is armed to answer
   * (#18062), so a question asked while it isn't stays the person's.
   */
  proxyAllowlisted: boolean;
}

/**
 * The policy every lifetime asks questions under, the owner's and a Remote
 * Host's alike: the trusted gates, the proxy allowlist and the default
 * expiry as given (a Host has no model, so never allows a proxy), and advice allowed (protocol section 21). Advice is a
 * question with a finite deadline and a plan the agent states, which it may
 * carry out at its own discretion if nobody answers by then, for work its
 * agent could already do on its own: the library refuses it under any gate,
 * the origin's or one the agent names, registered or not, and for an
 * approval, so `design-review/final` and every other gate always wait for a
 * decision. A Host allows it as its owner does (#17942): it records the
 * deadline it signs in its own store and types the outcome into its own pane
 * from the relay, so nothing waits on an owner who may be asleep. Neither
 * proxy consent nor the involvement preference enters into it: an advisory
 * question still needs the answer its requirement resolves to, and its
 * deadline answers and approves nothing. A bridge signs one only when the
 * host also delivers its outcome (`DAINTREE_DELIVERS_ADVISORY_OUTCOMES`), and
 * the relay and one of the person's phones show it. The registry copies each
 * gate, so nothing holding the definitions above can change one after
 * registration.
 */
export function createTrustedPolicy(settings: TrustedPolicyOptions): PolicyRegistry {
  const policy = new PolicyRegistry({
    proxyAllowlisted: settings.proxyAllowlisted,
    defaultQuestionExpiryMs: settings.defaultQuestionExpiryMs,
    advisoryQuestions: true,
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

/**
 * The policy as Settings reads it, for these settings, at this revision. The
 * agents switched on for `ask_human` are read only by launches, never by the
 * registry questions are asked under.
 */
export function decisionsPolicyOf(
  settings: PolicySettings & Pick<DecisionsSettings, "askHumanAgents">,
  revision: number
): DecisionsPolicy {
  // The library's own rule for a question with no origin gate, so what
  // Settings says is what the registry does.
  const expiry = questionExpiryPolicy(settings.defaultQuestionExpiryMs);
  return {
    gates: describeTrustedGates(),
    defaultQuestionExpiryMs: expiry.defaultMs,
    maxQuestionExpiryMs: expiry.maxMs,
    askHumanAgents: [...settings.askHumanAgents],
    revision,
  };
}
