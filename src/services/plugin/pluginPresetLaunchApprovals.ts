import type { HostApprovedPluginPresetLaunch } from "@shared/utils/agentPresetLaunchConsent";

/**
 * The preset approval each plugin-launched pane in this view was started under
 * (#16324), so an automatic fallback hop can be held to the fallback content
 * the person approved with it. In memory only: the approval carries env values,
 * which never go into saved layout state, so a pane restored after a reload
 * hops as any pane does, on the chain the person configured.
 */
const approvals = new Map<string, HostApprovedPluginPresetLaunch>();

export function rememberApprovedPresetLaunch(
  terminalId: string,
  approval: HostApprovedPluginPresetLaunch
): void {
  approvals.set(terminalId, approval);
}

export function forgetApprovedPresetLaunch(terminalId: string): void {
  approvals.delete(terminalId);
}

/**
 * Whether a hop of this pane to `presetId`, whose content is now `content`, is
 * one the approval covers. A pane launched without one is always covered.
 */
export function fallbackHopApproved(
  terminalId: string,
  presetId: string,
  content: string
): boolean {
  const approval = approvals.get(terminalId);
  if (approval === undefined) return true;
  return approval.fallbacks.some(([id, approved]) => id === presetId && approved === content);
}

export function _resetApprovedPresetLaunchesForTests(): void {
  approvals.clear();
}
