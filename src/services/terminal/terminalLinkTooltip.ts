import type { Terminal } from "@xterm/xterm";
import { UI_TOOLTIP_DELAY_DURATION } from "@/lib/animationUtils";

// The `TooltipContent` card, as plain classes: the hint lives inside xterm's
// own element, where a portalled Radix tooltip has no trigger to anchor to.
// `xterm-hover` tells xterm the pointer over it is not over the text.
const TOOLTIP_CLASSES =
  "xterm-hover z-[var(--z-popover)] max-w-xs overflow-hidden rounded-[var(--radius-md)] surface-overlay shadow-overlay text-xs text-text-primary px-3 py-1.5 pointer-events-none whitespace-nowrap";

const POINTER_GAP_PX = 16;

interface TooltipState {
  element?: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
}

const shown = new WeakMap<Terminal, TooltipState>();

/**
 * Show `label` beside the pointer after the app's tooltip delay, inside the
 * terminal's element. One per terminal: a new call replaces the last. Text
 * only, so a plugin's name can never be markup.
 */
export function showTerminalLinkTooltip(
  terminal: Terminal,
  event: MouseEvent,
  label: string
): void {
  hideTerminalLinkTooltip(terminal);
  const host = terminal.element;
  if (!host) return;
  const state: TooltipState = {};
  shown.set(terminal, state);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (!host.isConnected) return;
    const element = document.createElement("div");
    element.className = TOOLTIP_CLASSES;
    element.setAttribute("role", "tooltip");
    element.textContent = label;
    element.style.position = "absolute";
    host.appendChild(element);
    state.element = element;

    const bounds = host.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(0, Math.min(x, bounds.width - width));
    // Below the pointer, or above it when the row is near the bottom edge.
    const below = y + POINTER_GAP_PX;
    const top = below + height <= bounds.height ? below : Math.max(0, y - POINTER_GAP_PX - height);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, UI_TOOLTIP_DELAY_DURATION);
}

export function hideTerminalLinkTooltip(terminal: Terminal): void {
  const state = shown.get(terminal);
  if (!state) return;
  shown.delete(terminal);
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.element?.remove();
}
