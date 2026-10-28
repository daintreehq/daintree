import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePluginRuntimeStore, type PluginTerminalLink } from "@/store/pluginRuntimeStore";
import { arePluginTerminalLinksEnabled } from "@/store/pluginTerminalLinkPreferencesStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { logError } from "@/utils/logger";
import type {
  TerminalLinkPatternArgs,
  TerminalLinkSubject,
  TerminalLinkUrlArgs,
} from "@shared/types/plugin";
import {
  TERMINAL_LINK_MAX_MATCHES_PER_ROW,
  urlMatchesTerminalLinkTarget,
  type TerminalLinkPatternMatch,
} from "@shared/utils/pluginTerminalLinks";
import { getTerminalLinkMatchClient, type TerminalLinkMatches } from "./terminalLinkMatchClient";

function isLive(entry: PluginTerminalLink, viewWorkspaceId: string | null): boolean {
  return (
    (entry.projectId === null || entry.projectId === viewWorkspaceId) &&
    arePluginTerminalLinksEnabled(entry.pluginId) &&
    actionService.has(entry.actionId)
  );
}

/**
 * Start mirroring plugin declarations into this view, if nothing has yet.
 * Called when a terminal's provider is built, so the first hover already has
 * the matchers to hand. Idempotent.
 */
export function initPluginTerminalLinks(): void {
  usePluginRuntimeStore.getState().init();
}

/**
 * The matchers on offer in this view right now: switched on, owned by no
 * project or by this view's, and with their command registered. Read on every
 * hover and click, never cached, so a plugin stopping or a switch flipping
 * takes effect on the next one. Ordered by plugin id, then declaration order,
 * so which of two overlapping matches wins never depends on load order.
 */
export function getLivePluginTerminalLinks(): PluginTerminalLink[] {
  const { terminalLinks } = usePluginRuntimeStore.getState();
  if (terminalLinks.length === 0) return [];
  const viewWorkspaceId = getViewWorkspaceId();
  return terminalLinks
    .filter((entry) => isLive(entry, viewWorkspaceId))
    .sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
}

/** The terminal a click came from, or `null` for one with no panel to name. */
export function getTerminalLinkSubject(terminalId: string): TerminalLinkSubject | null {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel) return null;
  return {
    panelId: terminalId,
    panelKind: panel.kind ?? "terminal",
    ...(panel.worktreeId ? { worktreeId: panel.worktreeId } : {}),
  };
}

export interface PluginPatternLinkMatch extends TerminalLinkPatternMatch {
  entry: PluginTerminalLink;
}

/**
 * The links to offer from each matcher's results, at most
 * {@link TERMINAL_LINK_MAX_MATCHES_PER_ROW}, in `entries` order. A match
 * overlapping one already taken is dropped, so the earlier matcher wins, and
 * only taken matches count toward the cap.
 */
export function selectPluginPatternLinks(
  entries: readonly PluginTerminalLink[],
  matchesByKey: TerminalLinkMatches
): PluginPatternLinkMatch[] {
  const found: PluginPatternLinkMatch[] = [];
  for (const entry of entries) {
    for (const match of matchesByKey[entry.key] ?? []) {
      if (found.length >= TERMINAL_LINK_MAX_MATCHES_PER_ROW) return found;
      const end = match.index + match.text.length;
      const overlaps = found.some(
        (taken) => match.index < taken.index + taken.text.length && taken.index < end
      );
      if (!overlaps) found.push({ ...match, entry });
    }
  }
  return found;
}

/**
 * Every plugin pattern match in one hovered row's text. The patterns run in a
 * worker, so a slow one never stalls the terminal; an unanswered request
 * offers no links.
 */
export async function findPluginPatternLinks(text: string): Promise<PluginPatternLinkMatch[]> {
  const entries = getLivePluginTerminalLinks().filter((entry) => entry.link.pattern !== undefined);
  if (entries.length === 0) return [];
  const matches = await getTerminalLinkMatchClient().match(
    text,
    entries.map((entry) => ({
      key: entry.key,
      pattern: entry.link.pattern!,
      ignoreCase: entry.link.ignoreCase === true,
    }))
  );
  return matches === null ? [] : selectPluginPatternLinks(entries, matches);
}

/**
 * Whether a match found on an earlier hover still stands: its matcher is still
 * live in this view and declared exactly as it was. A plugin reloaded with the
 * matcher changed or gone keeps its command, so the command alone can't say.
 */
export function isPluginPatternLinkCurrent(match: PluginPatternLinkMatch): boolean {
  const current = getLivePluginTerminalLinks().find((entry) => entry.key === match.entry.key);
  return (
    current !== undefined &&
    current.actionId === match.entry.actionId &&
    JSON.stringify(current.link) === JSON.stringify(match.entry.link)
  );
}

/**
 * The plugin that claims `url`, or `null`. Two claims on one URL go to the
 * longer path prefix, then to the earlier plugin id.
 */
export function findPluginUrlClaim(url: string): PluginTerminalLink | null {
  let best: PluginTerminalLink | null = null;
  let bestPrefixLength = -1;
  for (const entry of getLivePluginTerminalLinks()) {
    const target = entry.link.url;
    if (target === undefined || !urlMatchesTerminalLinkTarget(url, target)) continue;
    const prefixLength = target.pathPrefix?.length ?? 0;
    if (prefixLength > bestPrefixLength) {
      best = entry;
      bestPrefixLength = prefixLength;
    }
  }
  return best;
}

function dispatch(
  entry: PluginTerminalLink,
  args: TerminalLinkPatternArgs | TerminalLinkUrlArgs
): void {
  actionService
    .dispatch(entry.actionId, args, { source: "user" })
    .catch((error: unknown) =>
      logError("[pluginTerminalLinks] Failed to dispatch a plugin terminal link", error)
    );
}

/**
 * Hand a clicked pattern match to its plugin. Eligibility is checked again
 * here, since the switch or the plugin may have changed since the hover.
 * Returns false when nothing was dispatched.
 */
export function activatePluginPatternLink(
  match: PluginPatternLinkMatch,
  terminalId: string
): boolean {
  const subject = getTerminalLinkSubject(terminalId);
  if (subject === null || !isPluginPatternLinkCurrent(match)) return false;
  dispatch(match.entry, { ...subject, text: match.text, groups: match.groups });
  return true;
}

/**
 * Hand a clicked URL to the plugin that claims it. Returns false when no live
 * plugin does, or the terminal has no panel to name, and the caller opens the
 * URL as it always would.
 */
export function activatePluginUrlLink(url: string, terminalId: string): boolean {
  const entry = findPluginUrlClaim(url);
  if (entry === null) return false;
  const subject = getTerminalLinkSubject(terminalId);
  if (subject === null) return false;
  dispatch(entry, { ...subject, url });
  return true;
}
