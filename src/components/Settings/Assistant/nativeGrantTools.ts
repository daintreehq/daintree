import { actionService } from "@/services/ActionService";
import { pluralize } from "@/lib/pluralize";
import {
  MCP_GRANT_MAX_LIFETIME_MS,
  MCP_GRANT_TTL_MS,
  MCP_NATIVE_GRANT_MAX_MAX_USES,
  MCP_NATIVE_GRANT_MIN_MAX_USES,
  NATIVE_GRANT_TOOL_IDS,
} from "@shared/config/mcpGrants";

export interface NativeGrantTool {
  id: string;
  title: string;
}

const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

export function nativeGrantToolTitle(id: string): string {
  return actionService.getTitle(id) || id;
}

export function listNativeGrantTools(): NativeGrantTool[] {
  return NATIVE_GRANT_TOOL_IDS.map((id) => ({ id, title: nativeGrantToolTitle(id) })).sort((a, b) =>
    a.title.localeCompare(b.title)
  );
}

/** The use ceiling the form will send, or null when main would refuse it. */
export function parseNativeGrantMaxUses(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) &&
    value >= MCP_NATIVE_GRANT_MIN_MAX_USES &&
    value <= MCP_NATIVE_GRANT_MAX_MAX_USES
    ? value
    : null;
}

function minutes(ms: number): string {
  return pluralize(Math.round(ms / 60_000), "minute");
}

/**
 * What approving does, in the order the user weighs it: which calls stop
 * asking, how many uses, and for how long. Hedged where main is: the target
 * checks (a busy agent's terminal, a force delete's typed name) still ask, the
 * use is charged before the call runs, and the main-only tools return before
 * the refresh that renews the window.
 */
export function describeNativeGrant(titles: readonly string[], maxUses: number | null): string {
  const tools = titles.length === 0 ? "the tools you choose" : listFormat.format(titles);
  const sentences = [
    `The assistant can run ${tools} without Daintree's usual confirmation, even outside this session's tool set.`,
    "A few checks still ask, such as closing a busy agent's terminal or force-deleting a worktree.",
  ];
  if (maxUses !== null) {
    sentences.push(
      `Allows ${pluralize(maxUses, "use")} in total across these tools, and a call that fails still spends one.`
    );
  }
  sentences.push(
    `Lasts ${minutes(MCP_GRANT_TTL_MS)}, which most successful calls renew, and ends ${minutes(MCP_GRANT_MAX_LIFETIME_MS)} after approval at the latest.`
  );
  return sentences.join(" ");
}

export const NATIVE_GRANT_MAX_USES_HINT = `Enter a whole number from ${MCP_NATIVE_GRANT_MIN_MAX_USES} to ${MCP_NATIVE_GRANT_MAX_MAX_USES}`;
