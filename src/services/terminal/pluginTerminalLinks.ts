import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePluginRuntimeStore, type PluginTerminalLink } from "@/store/pluginRuntimeStore";
import { arePluginTerminalLinksEnabled } from "@/store/pluginTerminalLinkPreferencesStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { logError, logWarn } from "@/utils/logger";
import type {
  TerminalLinkPatternArgs,
  TerminalLinkSubject,
  TerminalLinkUrlArgs,
} from "@shared/types/plugin";
import {
  TERMINAL_LINK_MAX_MATCHES_PER_ROW,
  compileTerminalLinkPattern,
  findTerminalLinkMatches,
  urlMatchesTerminalLinkTarget,
  type TerminalLinkPatternMatch,
} from "@shared/utils/pluginTerminalLinks";

/**
 * A matcher whose scan of one row took longer than this is switched off for
 * the rest of the session. The manifest check bounds a pattern's worst case,
 * but it is an estimate, and the renderer thread can't interrupt a running
 * `exec` — this keeps a misjudged pattern to one slow hover.
 */
const SLOW_SCAN_MS = 50;

const compiledPatterns = new Map<string, RegExp | null>();
const slowMatchers = new Set<string>();

function compiledPattern(entry: PluginTerminalLink): RegExp | null {
  const { pattern, ignoreCase } = entry.link;
  if (pattern === undefined) return null;
  const cacheKey = `${ignoreCase === true ? "i" : ""}/${pattern}`;
  let regex = compiledPatterns.get(cacheKey);
  if (regex === undefined) {
    regex = compileTerminalLinkPattern(pattern, ignoreCase === true);
    compiledPatterns.set(cacheKey, regex);
  }
  return regex;
}

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
 * Every plugin pattern match in one row's text, at most
 * {@link TERMINAL_LINK_MAX_MATCHES_PER_ROW}. A match overlapping one already
 * taken is dropped, so the earlier matcher wins.
 */
export function findPluginPatternLinks(
  text: string,
  entries: readonly PluginTerminalLink[] = getLivePluginTerminalLinks()
): PluginPatternLinkMatch[] {
  const found: PluginPatternLinkMatch[] = [];
  for (const entry of entries) {
    if (found.length >= TERMINAL_LINK_MAX_MATCHES_PER_ROW) break;
    const regex = compiledPattern(entry);
    if (regex === null || slowMatchers.has(entry.key)) continue;
    const started = performance.now();
    const matches = findTerminalLinkMatches(
      regex,
      text,
      TERMINAL_LINK_MAX_MATCHES_PER_ROW - found.length
    );
    const elapsed = performance.now() - started;
    if (elapsed > SLOW_SCAN_MS) {
      slowMatchers.add(entry.key);
      logWarn("Switched off a slow plugin terminal link matcher for this session", {
        pluginId: entry.pluginId,
        matcherId: entry.link.id,
        elapsedMs: Math.round(elapsed),
      });
    }
    for (const match of matches) {
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
  if (subject === null || !isLive(match.entry, getViewWorkspaceId())) return false;
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

/** Test-only: forget compiled patterns and slow-matcher verdicts. */
export function _resetPluginTerminalLinksForTest(): void {
  compiledPatterns.clear();
  slowMatchers.clear();
}
