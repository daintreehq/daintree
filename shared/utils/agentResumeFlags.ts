import {
  getPluginBypassArgHistory,
  reconcileBypassFlags,
  reconcileDecorationFlags,
  reconcileInlineModeFlag,
  resolveEffectiveBypass,
  resolveKeepDecorations,
  type AgentSettings,
} from "../types/agentSettings.js";
import { splitCallerLaunchFlags } from "./callerLaunchFlags.js";

/**
 * Reconciles a resumed session's persisted launch flags against the given
 * agent settings (#10432 skip-permissions, the "resume trap"): the snapshot may
 * have been captured while the global switch was in a different state, so
 * strip the agent's canonical bypass flag and re-add it only if it currently
 * resolves. The screen-mode token is brought to inline whatever the snapshot
 * held (#16356).
 *
 * Pure, so the renderer (from its settings store) and main (from the saved
 * settings) reconcile a resume the same way.
 */
export function reconcileResumeLaunchFlagsWith(
  session: {
    agentId: string;
    agentLaunchFlags?: string[];
    /** The caller's verbatim tail (#13046), re-appended untouched after reconcile. */
    callerLaunchFlags?: string[];
  },
  settings: AgentSettings | null | undefined
): string[] {
  const entry = settings?.agents?.[session.agentId] ?? {};
  const effectiveBypass = resolveEffectiveBypass(
    entry,
    session.agentId,
    settings?.globalSkipPermissions
  );
  const { base, caller } = splitCallerLaunchFlags(
    session.agentLaunchFlags,
    session.callerLaunchFlags
  );
  // Pass [] when no flags were captured so a global-on still injects the token
  // for a supported agent (each reconcile no-ops for agents without one).
  const reconciled = reconcileDecorationFlags(
    reconcileInlineModeFlag(
      reconcileBypassFlags(
        base,
        session.agentId,
        effectiveBypass,
        entry.dangerousArgs as string | undefined,
        getPluginBypassArgHistory(settings, session.agentId)
      ),
      session.agentId
    ),
    session.agentId,
    resolveKeepDecorations(entry)
  );
  return caller.length > 0 ? [...reconciled, ...caller] : reconciled;
}
