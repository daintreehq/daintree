import { KeyRound, ShieldBan, Wrench, type LucideIcon } from "lucide-react";
import type { AgentAvailabilityState } from "@shared/types";
import {
  isAgentBlocked,
  isAgentInstalled,
  isAgentReady,
  isAgentUnauthenticated,
} from "../../../shared/utils/agentAvailability";

/**
 * What the CLI agents page says about one agent's install state.
 *
 * - `ready` carries no label: labelling every healthy agent "Ready" is the same word
 *   fourteen times, so counts say it once instead.
 * - `attention` is installed but not straightforwardly usable, and carries the glyph
 *   that states the severity — never status-coloured text, which fails 4.5:1 as body
 *   copy on most themes.
 * - `missing` is not installed. That is a fact, not a fault, so it has a plain label and
 *   no warning glyph.
 *
 * Wording states what the probe saw, not what it implies: `unauthenticated` only means
 * no credentials were found where Daintree looked, and the CLI may still launch.
 * Attention states are tested before `ready` so a probe that ever reports both still
 * surfaces the problem.
 */
export type AgentHealth =
  | { kind: "ready" }
  | { kind: "attention"; label: string; Icon: LucideIcon }
  | { kind: "missing"; label: string }
  | { kind: "unknown" };

export function getAgentHealth(state: AgentAvailabilityState | undefined): AgentHealth {
  if (state === undefined) return { kind: "unknown" };
  if (isAgentBlocked(state)) return { kind: "attention", label: "Blocked", Icon: ShieldBan };
  if (isAgentUnauthenticated(state)) {
    return { kind: "attention", label: "No credentials detected", Icon: KeyRound };
  }
  if (isAgentReady(state)) return { kind: "ready" };
  // "Needs setup" is the app's word for this state everywhere else (System status,
  // the toolbar button, the dock launcher), so the picker and inventory use it too.
  if (isAgentInstalled(state)) return { kind: "attention", label: "Needs setup", Icon: Wrench };
  return { kind: "missing", label: "Not installed" };
}
