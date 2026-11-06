import {
  reconcileBypassFlags,
  reconcileDecorationFlags,
  reconcileInlineModeFlag,
  resolveEffectiveBypass,
  resolveEffectiveInlineMode,
  resolveKeepDecorations,
  type AgentSettings,
} from "../types/agentSettings.js";
import { splitCallerLaunchFlags } from "./callerLaunchFlags.js";

/**
 * Reconciles a resumed session's persisted launch flags against the given
 * agent settings (#10432 skip-permissions, #10876 alt-screen — both "resume
 * traps"): the snapshot may have been captured while a global switch was in a
 * different state, so strip the agent's canonical bypass / inline flags and
 * re-add them only if they currently resolve.
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
  const effectiveInline = resolveEffectiveInlineMode(
    entry,
    session.agentId,
    settings?.globalUseAltScreen
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
        entry.dangerousArgs as string | undefined
      ),
      session.agentId,
      effectiveInline
    ),
    session.agentId,
    resolveKeepDecorations(entry)
  );
  return caller.length > 0 ? [...reconciled, ...caller] : reconciled;
}
