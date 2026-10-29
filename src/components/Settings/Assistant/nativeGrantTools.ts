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
 * asking, how many of them, and for how long. The use count is shared across
 * every tool in the grant and is charged before the call runs, so a call that
 * fails still spends one; only a successful call restarts the window.
 */
export function describeNativeGrant(titles: readonly string[], maxUses: number | null): string {
  const scope =
    titles.length === 0
      ? "The assistant can run the tools you choose without asking you"
      : `The assistant can run ${listFormat.format(titles)} without asking you`;
  const uses =
    maxUses === null
      ? `Set maximum uses to a whole number from ${MCP_NATIVE_GRANT_MIN_MAX_USES} to ${MCP_NATIVE_GRANT_MAX_MAX_USES}.`
      : `Up to ${pluralize(maxUses, "call")} across these tools, including any that fail.`;
  return [
    `${scope}, even outside this session's tool set. Daintree skips its usual confirmation for them.`,
    uses,
    `Lasts ${minutes(MCP_GRANT_TTL_MS)}, restarting with each successful call, and ends ${minutes(MCP_GRANT_MAX_LIFETIME_MS)} after approval at the latest.`,
  ].join(" ");
}
