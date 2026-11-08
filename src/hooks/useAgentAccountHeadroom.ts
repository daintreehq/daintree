import { useCallback, useEffect, useState } from "react";
import {
  accountHeadroom,
  type AccountHeadroom,
  type AccountHeadroomTarget,
} from "@/utils/agentAccountHeadroom";
import { useClaudeUsage } from "./useClaudeUsage";
import { useCodexQuota } from "./useCodexQuota";
import { useVisibilityAwareInterval } from "./useVisibilityAwareInterval";

/** Keeps ages and the "stale" mark honest between the quota hooks' own reads. */
const CLOCK_TICK_MS = 30_000;

/**
 * The known quota headroom of an agent's account choices (#16407), for one
 * choice surface. Nothing is read while the surface is closed: Codex's quota
 * is asked for and Claude Code's pane-observed readings are collected only
 * while `open`, and only for the agent that has them. Call it once per
 * surface, not once per choice.
 */
export function useAgentAccountHeadroom(
  agentId: string | undefined,
  open: boolean
): (target: AccountHeadroomTarget) => AccountHeadroom | undefined {
  const codexOpen = open && agentId === "codex";
  const claudeOpen = open && agentId === "claude";
  const { profiles } = useCodexQuota(codexOpen);
  const { accounts } = useClaudeUsage(claudeOpen);
  const [now, setNow] = useState(() => Date.now());

  // The surface may have sat closed for hours, so its clock restarts on open.
  useEffect(() => {
    if (open) setNow(Date.now());
  }, [open]);
  useVisibilityAwareInterval(() => setNow(Date.now()), CLOCK_TICK_MS, open);

  return useCallback(
    (target: AccountHeadroomTarget) =>
      accountHeadroom(agentId, target, { codex: profiles, claude: accounts }, now),
    [agentId, profiles, accounts, now]
  );
}
