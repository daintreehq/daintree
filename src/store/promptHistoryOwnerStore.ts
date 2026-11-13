import { create } from "zustand";

/**
 * Marks the element whose focus makes the composer inside it the one prompt
 * history serves: the Assistant's aside, Canopy, its docked global assistant.
 * The nearest one to the focus wins, so a host may nest another.
 */
export const PROMPT_HISTORY_HOST_ATTR = "data-prompt-history-host";

const HOST_SELECTOR = `[${PROMPT_HISTORY_HOST_ATTR}]`;
const PANE_SELECTOR = "[data-panel-id]";

/**
 * The composer whose prompt history the view's one palette serves: by `:` in
 * the Action Palette, `⌘R`, or its `❯`. `null` is the grid's focused pane;
 * otherwise the composer outside the grid whose host focus last landed in.
 * Nothing but focus reaching a grid pane, or the composer going, hands it
 * back, so a palette or dialog taking focus on the way leaves it where the
 * user was working.
 */
interface PromptHistoryOwnerState {
  owner: string | null;
}

export const usePromptHistoryOwnerStore = create<PromptHistoryOwnerState>(() => ({
  owner: null,
}));

interface Follower {
  token: string;
  composer: HTMLElement;
  /** Its nearest host, or none: then only focus in the composer itself counts. */
  host: Element | null;
}

const followers: Follower[] = [];
/**
 * The host whose composer just went while holding history, until the effects
 * of that commit have run: the composer replacing it there (a remount for a
 * new input owner, Project and Global trading places in the aside) takes
 * history back, focus having gone with the old editor.
 */
let vacatedHost: Element | null = null;
let listening: Document | null = null;

function setOwner(owner: string | null): void {
  if (usePromptHistoryOwnerStore.getState().owner !== owner) {
    usePromptHistoryOwnerStore.setState({ owner });
  }
}

export function claimPromptHistory(token: string): void {
  vacatedHost = null;
  setOwner(token);
}

/** Hands history back to the grid's focused pane, for a press on a pane's own `❯`. */
export function returnPromptHistoryToGrid(): void {
  vacatedHost = null;
  setOwner(null);
}

function serves(follower: Follower, target: Element): boolean {
  if (follower.host === null) return follower.composer.contains(target);
  const at = target.closest(HOST_SELECTOR);
  if (at === follower.host) return true;
  // A host with no composer of its own (Canopy showing no run) lends its
  // focus to the one nested in it.
  return at !== null && at.contains(follower.host) && !followers.some((other) => other.host === at);
}

/** The composer focus at `target` belongs to; the latest to follow wins a tie. */
function servedBy(target: Element): Follower | undefined {
  for (let i = followers.length - 1; i >= 0; i--) {
    if (serves(followers[i]!, target)) return followers[i];
  }
  return undefined;
}

function focusedElement(doc: Document): Element | null {
  const focused = doc.activeElement;
  return focused !== null && focused !== doc.body ? focused : null;
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const follower = servedBy(target);
  if (follower) claimPromptHistory(follower.token);
  else if (target.closest(PANE_SELECTOR) !== null) returnPromptHistoryToGrid();
}

/**
 * Follows focus for one composer outside the grid: it holds prompt history
 * whenever focus lands in its host, from the start if focus is already there.
 * Cleanup hands history to whichever composer now serves the focus, else back
 * to the grid.
 */
export function followPromptHistoryHost(token: string, composer: HTMLElement): () => void {
  const doc = composer.ownerDocument;
  const follower: Follower = { token, composer, host: composer.closest(HOST_SELECTOR) };
  followers.push(follower);
  if (listening === null) {
    doc.addEventListener("focusin", onFocusIn, true);
    listening = doc;
  }

  const owner = usePromptHistoryOwnerStore.getState().owner;
  const focused = focusedElement(doc);
  if (owner === null && vacatedHost !== null && vacatedHost === follower.host) {
    claimPromptHistory(token);
  } else if (focused !== null && servedBy(focused) === follower) {
    claimPromptHistory(token);
  }

  return () => {
    const index = followers.indexOf(follower);
    if (index !== -1) followers.splice(index, 1);
    if (followers.length === 0 && listening !== null) {
      listening.removeEventListener("focusin", onFocusIn, true);
      listening = null;
    }
    if (usePromptHistoryOwnerStore.getState().owner !== token) return;
    const now = focusedElement(doc);
    const next = now !== null ? servedBy(now) : undefined;
    if (next) {
      claimPromptHistory(next.token);
      return;
    }
    setOwner(null);
    const vacated = follower.host;
    vacatedHost = vacated;
    queueMicrotask(() => {
      if (vacatedHost === vacated) vacatedHost = null;
    });
  };
}
