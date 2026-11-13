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

export function claimPromptHistory(token: string): void {
  if (usePromptHistoryOwnerStore.getState().owner === token) return;
  usePromptHistoryOwnerStore.setState({ owner: token });
}

export function releasePromptHistory(token: string): void {
  if (usePromptHistoryOwnerStore.getState().owner !== token) return;
  usePromptHistoryOwnerStore.setState({ owner: null });
}

/** Whether focus at `target` is in `composer`'s host, and not in a host nested inside it. */
function inHostOf(composer: Element, target: Element): boolean {
  const host = composer.closest(HOST_SELECTOR);
  return host !== null ? target.closest(HOST_SELECTOR) === host : composer.contains(target);
}

/**
 * Claims prompt history for `token` whenever focus lands in its composer's
 * host, and from the start if it already holds focus; hands it back to the
 * grid when focus reaches a grid pane, and on cleanup.
 */
export function followPromptHistoryHost(token: string, composer: HTMLElement): () => void {
  const doc = composer.ownerDocument;
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (inHostOf(composer, target)) claimPromptHistory(token);
    else if (target.closest(PANE_SELECTOR) !== null) releasePromptHistory(token);
  };
  const focused = doc.activeElement;
  if (focused !== null && focused !== doc.body && inHostOf(composer, focused)) {
    claimPromptHistory(token);
  }
  doc.addEventListener("focusin", onFocusIn, true);
  return () => {
    doc.removeEventListener("focusin", onFocusIn, true);
    releasePromptHistory(token);
  };
}
