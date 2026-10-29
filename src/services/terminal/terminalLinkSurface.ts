import type { IBufferRange, IDisposable, ILinkHandler, Terminal } from "@xterm/xterm";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import { useHelpPanelStore, selectSlot, selectSlotForTerminal } from "@/store/helpPanelStore";
import { logWarn } from "@/utils/logger";
import {
  createFileLinksAddon,
  createImageLinksAddon,
  createPluginTerminalLinksAddon,
  createSuggestedCommandLinksAddon,
  createWebLinksAddon,
} from "./TerminalAddonManager";
import type { FileLinkRoute } from "./FileLinksAddon";
import type { OpenLinkOptions } from "./TerminalLinkHandler";
import {
  activatePluginPatternLink,
  findPluginPatternLinks,
  findPluginUrlClaim,
  getTerminalLinkSubject,
  initPluginTerminalLinks,
  isPluginPatternLinkCurrent,
} from "./pluginTerminalLinks";
import { hideTerminalLinkTooltip, showTerminalLinkTooltip } from "./terminalLinkTooltip";
import { isSuggestedCommandSource, runSuggestedCommand } from "./suggestedCommandRunner";
import type { TerminalLink } from "./types";

/**
 * Where one xterm's links lead. A grid pane and Canopy's live view of the same
 * run both build their links from one of these, so a link added to either
 * reaches the other, and differs only in what the target says about the run.
 */
export interface TerminalLinkTarget {
  /**
   * The id this view's panels, plugins, help lanes and suggested commands know
   * the terminal by, or null for a terminal this view doesn't hold: another
   * project's or another host's run, whose links then open on their own.
   */
  terminalId: string | null;
  /** The xterm the links are on now; null once it has gone. */
  getTerminal(): Terminal | null;
  /** The directory relative paths resolve against: the run's own. */
  getCwd(): string;
  /** The agent the terminal runs now, for links only some agents print. */
  getRuntimeAgentId(): string | undefined;
  /** The URL, file or folder under the pointer, for the context menu. */
  setHoveredLink(link: TerminalLink | null): void;
  /** Opens a URL the terminal printed, from the run's own host. */
  openLink(url: string, event?: MouseEvent, options?: OpenLinkOptions): void;
  /** How file and folder links open, when not the grid's own way. */
  fileRoute?: FileLinkRoute;
}

/** The ordered link providers one terminal holds, each null until built. */
export interface TerminalLinkSlots {
  commandLinksDisposable: IDisposable | null;
  fileLinksDisposable: IDisposable | null;
  imageLinksDisposable: IDisposable | null;
  webLinksAddon: WebLinksAddon | null;
  pluginLinksDisposable: IDisposable | null;
}

/**
 * Options every terminal is constructed with. The OSC 8 handler must be there
 * from the start: without one, xterm answers a click with its own
 * `confirm()` prompt instead of opening the link.
 */
export function sharedTerminalOptions(target: TerminalLinkTarget): {
  rescaleOverlappingGlyphs: true;
  linkHandler: ILinkHandler;
} {
  return { rescaleOverlappingGlyphs: true, linkHandler: createOscLinkHandler(target) };
}

function hideTooltip(target: TerminalLinkTarget): void {
  const terminal = target.getTerminal();
  if (terminal) hideTerminalLinkTooltip(terminal);
}

function openUrl(target: TerminalLinkTarget, uri: string, event?: MouseEvent): void {
  hideTooltip(target);
  target.openLink(uri, event);
}

/** Whether the terminal is one a plugin can be handed a link from. */
function hasLinkSubject(target: TerminalLinkTarget): boolean {
  return target.terminalId !== null && getTerminalLinkSubject(target.terminalId) !== null;
}

/** Names the plugin a hovered URL goes to, when one claims it (#13798). */
function showUrlClaimTooltip(target: TerminalLinkTarget, event: MouseEvent, url: string): void {
  const terminal = target.getTerminal();
  if (!terminal || !hasLinkSubject(target)) return;
  const claim = findPluginUrlClaim(url);
  if (claim) showTerminalLinkTooltip(terminal, event, `Open with ${claim.pluginName}`);
}

/**
 * The plugin a hovered URL would go to, or null when none claims it or the
 * terminal has no subject to hand it with.
 */
export function hoveredUrlPluginName(
  target: Pick<TerminalLinkTarget, "terminalId">,
  link: TerminalLink | null
): string | null {
  if (link?.kind !== "url" || target.terminalId === null) return null;
  if (getTerminalLinkSubject(target.terminalId) === null) return null;
  return findPluginUrlClaim(link.text)?.pluginName ?? null;
}

/**
 * A synthetic link for the web-links addon and OSC 8 sources, which expose no
 * ILink of their own, so the context menu can open what is hovered.
 */
function makeSyntheticLink(
  target: TerminalLinkTarget,
  text: string,
  range: IBufferRange | null
): TerminalLink {
  return {
    kind: "url",
    range: range ?? { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
    text,
    activate: (event: MouseEvent, uri: string) => openUrl(target, uri, event),
  };
}

function createOscLinkHandler(target: TerminalLinkTarget): ILinkHandler {
  return {
    activate: (event: MouseEvent, text: string) => openUrl(target, text, event),
    hover: (event: MouseEvent, text: string, range: IBufferRange) => {
      target.setHoveredLink(makeSyntheticLink(target, text, range));
      showUrlClaimTooltip(target, event, text);
    },
    leave: () => {
      target.setHoveredLink(null);
      hideTooltip(target);
    },
  };
}

/**
 * Registers the link providers a slot doesn't hold yet, in the one order every
 * terminal uses. Idempotent, so a caller rebuilding after a tier change or a
 * failure can call it again.
 */
export function installTerminalLinkProviders(
  terminal: Terminal,
  slots: TerminalLinkSlots,
  target: TerminalLinkTarget
): void {
  const id = target.terminalId;
  // Claude Code's `! command` suggestions register first: xterm gives an
  // overlapping link to the earliest provider, and a suggestion often holds a
  // path or URL that must not take the click away from the whole command.
  // Set when this call registers a built-in provider: one created after the
  // plugin provider (a help lane bound later, a retried failure) would rank
  // below it, so the plugin provider is then registered again, last.
  let builtInAdded = false;
  if (!slots.commandLinksDisposable) {
    try {
      slots.commandLinksDisposable = createSuggestedCommandLinksAddon(
        terminal,
        () => id !== null && isSuggestedCommandSource(id, target.getRuntimeAgentId()),
        (command) => {
          if (id !== null) runSuggestedCommand(id, command);
        }
      );
      builtInAdded = true;
    } catch (err) {
      logWarn("Failed to create SuggestedCommandLinksAddon", { id, error: err });
    }
  }
  if (!slots.fileLinksDisposable) {
    try {
      slots.fileLinksDisposable = createFileLinksAddon(
        terminal,
        () => target.getCwd(),
        (link) => target.setHoveredLink(link),
        target.fileRoute
      );
      builtInAdded = true;
    } catch (err) {
      logWarn("Failed to create FileLinksAddon", { id, error: err });
    }
  }
  // `[image #N]` references are clickable only in the assistant terminal,
  // where the help session owns the figure state (#9830). Gating on the
  // bound help terminal keeps grid terminals that happen to print the token
  // inert, and the provider rebuilds with the rest on tier promotion.
  // Resolve the lane at build time, then re-resolve on every read: a terminal
  // belongs to exactly one lane, but which one can change if the lane is
  // relaunched, and reading a sibling lane's figures would make `[image #N]`
  // point at another conversation's picture (#12108).
  if (
    !slots.imageLinksDisposable &&
    id !== null &&
    selectSlotForTerminal(useHelpPanelStore.getState(), id) !== null
  ) {
    try {
      slots.imageLinksDisposable = createImageLinksAddon(
        terminal,
        () => {
          const state = useHelpPanelStore.getState();
          const slot = selectSlotForTerminal(state, id);
          if (slot === null) return [];
          return selectSlot(state, slot).figures.map((f) => f.figureNumber);
        },
        (figureNumber, openLightbox) => {
          const state = useHelpPanelStore.getState();
          const slot = selectSlotForTerminal(state, id);
          if (slot === null) return;
          // Plain click marks the figure current in the rail; Cmd/Ctrl+click
          // also opens it in the lightbox.
          state.activateFigure(slot, figureNumber, openLightbox);
        }
      );
      builtInAdded = true;
    } catch (err) {
      logWarn("Failed to create ImageLinksAddon", { id, error: err });
    }
  }
  if (!slots.webLinksAddon) {
    try {
      slots.webLinksAddon = createWebLinksAddon(
        terminal,
        (event, uri) => openUrl(target, uri, event),
        {
          hover: (event, text) => {
            target.setHoveredLink(makeSyntheticLink(target, text, null));
            showUrlClaimTooltip(target, event, text);
          },
          leave: () => {
            target.setHoveredLink(null);
            hideTooltip(target);
          },
        }
      );
      builtInAdded = true;
    } catch (err) {
      logWarn("Failed to create WebLinksAddon", { id, error: err });
    }
  }
  // Plugin pattern matchers (#13798) register after every built-in provider:
  // xterm hands an overlapping link to the earliest one, so a plugin's match
  // never takes a click from a path, URL, figure or suggested command. The
  // matchers are read live on each hover, so nothing here rebuilds when a
  // plugin loads, stops or is switched off.
  if (builtInAdded && slots.pluginLinksDisposable) {
    slots.pluginLinksDisposable.dispose();
    slots.pluginLinksDisposable = null;
  }
  if (!slots.pluginLinksDisposable) {
    try {
      initPluginTerminalLinks();
      slots.pluginLinksDisposable = createPluginTerminalLinksAddon(terminal, {
        find: (text) =>
          hasLinkSubject(target) ? findPluginPatternLinks(text) : Promise.resolve([]),
        activate: (match) => {
          hideTerminalLinkTooltip(terminal);
          if (id !== null) activatePluginPatternLink(match, id);
        },
        // xterm keeps a row's links while the pointer stays on it, so a link
        // found before its plugin was switched off can still be hovered.
        hover: (match, event) => {
          if (!isPluginPatternLinkCurrent(match)) return;
          showTerminalLinkTooltip(terminal, event, `Open with ${match.entry.pluginName}`);
        },
        leave: () => hideTerminalLinkTooltip(terminal),
      });
    } catch (err) {
      logWarn("Failed to create PluginTerminalLinksAddon", { id, error: err });
    }
  }
}

/** Disposes every provider a slot holds, leaving the slots empty to build again. */
export function disposeTerminalLinkProviders(slots: TerminalLinkSlots): void {
  slots.commandLinksDisposable?.dispose();
  slots.commandLinksDisposable = null;
  slots.fileLinksDisposable?.dispose();
  slots.fileLinksDisposable = null;
  slots.imageLinksDisposable?.dispose();
  slots.imageLinksDisposable = null;
  slots.webLinksAddon?.dispose();
  slots.webLinksAddon = null;
  slots.pluginLinksDisposable?.dispose();
  slots.pluginLinksDisposable = null;
}
