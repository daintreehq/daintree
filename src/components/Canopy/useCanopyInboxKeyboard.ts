import type { KeyboardEvent, RefObject } from "react";
import { isMac } from "@/lib/platform";
import {
  canopyCardDomId,
  type CanopyCardHandle,
  type CanopyCardHandlers,
  type CanopyPaneFocus,
} from "./CanopyCard";
import type { CanopyInbox, CanopyItem } from "./canopyModel";
import type { CanopyAssistantItem } from "./canopyAssistants";

/**
 * ⌘↑/⌘↓ on macOS, Alt+↑/↓ elsewhere (Slack's channel switch): the agent above
 * or below, from anywhere in the panel. Ctrl+↑/↓ is not used off the Mac
 * because terminals send it to the program as its own key.
 */
function agentStepOf(event: KeyboardEvent<HTMLElement>): -1 | 1 | null {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  // An input method's own keys: switching agents would unmount what it is composing in.
  if (event.nativeEvent.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey) return null;
  const chord = isMac()
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey;
  if (!chord) return null;
  return event.key === "ArrowUp" ? -1 : 1;
}

/** Where the keyboard is inside the pane: the reply composer, the live terminal, or neither. */
function paneFocusOf(element: Element | null): CanopyPaneFocus {
  if (!element) return null;
  if (element.closest("[data-canopy-detail] .cm-editor")) return "composer";
  if (element.closest("[data-canopy-detail] [data-canopy-terminal]")) return "terminal";
  return null;
}

/**
 * The panel's keys: the search's, the list's, the assistant list's, and the
 * agent step taken from anywhere in the panel, each acting on the run or
 * assistant selected.
 */
export function useCanopyInboxKeyboard({
  visible,
  listed,
  shownInbox,
  shownAssistants,
  archivedShown,
  focusedIndex,
  activeIndex,
  focusedItem,
  selectedAssistant,
  searchRef,
  detailRef,
  selectNow,
  focusCardNow,
  openPaneNow,
  focusAssistantNow,
  openAssistant,
  onOpen,
  askRename,
  toggleRead,
  markAllRead,
}: {
  /** What the keyboard walks: the list, then the archived runs once shown. */
  visible: CanopyItem[];
  listed: CanopyItem[];
  shownInbox: CanopyInbox;
  shownAssistants: CanopyAssistantItem[];
  archivedShown: boolean;
  focusedIndex: number;
  activeIndex: number;
  focusedItem: CanopyItem | null;
  selectedAssistant: CanopyAssistantItem | null;
  searchRef: RefObject<HTMLInputElement | null>;
  detailRef: RefObject<CanopyCardHandle | null>;
  selectNow: (runId: string) => void;
  focusCardNow: (runId: string) => void;
  openPaneNow: (runId: string, focus: CanopyPaneFocus) => void;
  focusAssistantNow: (id: string) => void;
  openAssistant: (item: CanopyAssistantItem) => void;
  onOpen: CanopyCardHandlers["onOpen"];
  askRename: (item: CanopyItem) => void;
  toggleRead: (item: CanopyItem) => void;
  markAllRead: () => void;
}) {
  // The assistant list's own keys: its rows walk among themselves, and step
  // off either end into the worker list around them, or back to the search.
  const onAssistantKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const last = shownAssistants.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") {
      if (index === last && archivedShown && shownInbox.archived.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        focusCardNow(shownInbox.archived[0]!.runId);
        return;
      }
      next = Math.min(last, index + 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      if (index === 0) {
        event.preventDefault();
        event.stopPropagation();
        if (listed.length > 0) focusCardNow(listed[listed.length - 1]!.runId);
        else searchRef.current?.focus();
        return;
      }
      next = index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    } else if (event.key === "/") {
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      openAssistant(shownAssistants[index]!);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    focusAssistantNow(shownAssistants[next]!.id);
  };

  // ⌘↑/⌘↓ from anywhere in the panel, the live terminal and the composer
  // included: taken in the capture phase, before xterm or CodeMirror can, so
  // the user can work down the list — reply, next, reply — without leaving the
  // keyboard where it is. The keyboard lands in the same place on the next run.
  const onAgentStepKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    const step = agentStepOf(event);
    if (step === null || visible.length === 0) return;
    // Renaming: ⌘↑/↓ move the caret in the name, not to another agent.
    if (event.target instanceof Element && event.target.closest("[data-canopy-rename]")) return;
    event.preventDefault();
    event.stopPropagation();
    // From the open run, clamped at the ends rather than wrapping: the bottom
    // of the list is the end of it. An open run that is not in the list
    // (archived and folded away) steps onto the list's first or last row.
    const current = visible.findIndex((item) => item.runId === focusedItem?.runId);
    const next =
      current === -1
        ? visible[step > 0 ? 0 : visible.length - 1]!
        : visible[Math.min(visible.length - 1, Math.max(0, current + step))]!;
    if (next.runId === focusedItem?.runId) return;
    const focus = paneFocusOf(document.activeElement);
    // From the search the selection moves and the keyboard stays to type.
    if (event.target === searchRef.current) selectNow(next.runId);
    else if (focus === null) focusCardNow(next.runId);
    else openPaneNow(next.runId, focus);
  };

  // On the list's own wrapper rather than the palette body: the body only acts
  // on keys aimed at itself, and here focus is always on a card or its controls.
  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (visible.length === 0) return;
    // Only from a row of the list: the pane holds a live terminal and a
    // composer whose keys belong to the agent, and the fold owns its own keys.
    if (!(event.target instanceof Element) || !event.target.closest("[data-canopy-card]")) return;
    // Shift+F10 or the Menu key: the selected row's menu, as a right-click
    // opens it. Replayed as a contextmenu on the row, since the menu has no
    // way to be opened by hand, and macOS sends none for these keys itself.
    if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)
    ) {
      const row = visible[activeIndex]
        ? document.getElementById(canopyCardDomId(visible[activeIndex]!.runId))
        : null;
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 8,
          clientY: rect.top + rect.height / 2,
        })
      );
      return;
    }
    // The selected run's own chords (Trash is ⌘⌫) go to it before the
    // modifier guard below, which keeps app shortcuts out of plain navigation.
    if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
      if (detailRef.current?.handleKey(event)) return;
    }
    // ⌥U marks every unread run listed read. By the key's place, not its
    // character: on a Mac ⌥U is the umlaut dead key and types no "u".
    if (event.code === "KeyU" && event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (!event.repeat) markAllRead();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // The assistants sit between the inbox and the archived runs: down off the
    // inbox's end, or up off the archived runs' top, steps into them.
    if (shownAssistants.length > 0 && focusedIndex !== -1) {
      const down = event.key === "ArrowDown" || event.key === "j";
      const up = event.key === "ArrowUp" || event.key === "k";
      if ((down && focusedIndex === listed.length - 1) || (up && focusedIndex === listed.length)) {
        event.preventDefault();
        focusAssistantNow(shownAssistants[down ? 0 : shownAssistants.length - 1]!.id);
        return;
      }
    }
    // Back to the search: "/" from any row, or up off the top of the list.
    const search = searchRef.current;
    if (search && (event.key === "/" || (event.key === "ArrowUp" && activeIndex === 0))) {
      event.preventDefault();
      search.focus();
      if (event.key === "/") search.select();
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") {
      next = Math.min(visible.length - 1, activeIndex + 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      next = Math.max(0, activeIndex - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = visible.length - 1;
    }
    if (next !== null) {
      event.preventDefault();
      focusCardNow(visible[next]!.runId);
      return;
    }
    // Keys aimed at the list's selected row act on the selected agent.
    const selected = visible[activeIndex];
    if (!selected) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onOpen(selected);
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      askRename(selected);
      return;
    }
    if ((event.key === "u" || event.key === "U") && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) toggleRead(selected);
      return;
    }
    detailRef.current?.handleKey(event);
  };

  // The search keeps every plain key for its text; only the list's moves, Go to
  // terminal and the modifier chords act from it, on the selected run. Tab takes
  // the keyboard down to that run's row, where the one-key actions are.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The IME owns the key: nothing of the search's or the panel's acts on it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    // An assistant in the pane, or no worker row ahead of the assistants: the
    // keys go to the assistant, never to a worker the person can't see.
    const toAssistant =
      selectedAssistant ??
      (listed.length === 0 && shownAssistants.length > 0 ? shownAssistants[0]! : null);
    if (plain && toAssistant !== null) {
      const target = toAssistant;
      if (event.key === "Tab" || (event.key === "ArrowDown" && listed.length === 0)) {
        event.preventDefault();
        event.stopPropagation();
        focusAssistantNow(target.id);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openAssistant(target);
        return;
      }
    }
    const selected = focusedIndex !== -1 ? visible[focusedIndex]! : (visible[0] ?? null);
    if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      if (visible.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      selectNow(visible[Math.min(visible.length - 1, Math.max(0, activeIndex + step))]!.runId);
      return;
    }
    if (plain && event.key === "Enter") {
      if (!selected) return;
      event.preventDefault();
      onOpen(selected);
      return;
    }
    if (plain && event.key === "Tab") {
      if (!selected) return;
      event.preventDefault();
      // The dialog's own Tab wrap must not take the keyboard on from the row.
      event.stopPropagation();
      focusCardNow(selected.runId);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
      if (selected?.runId === focusedItem?.runId) detailRef.current?.handleKey(event);
      return;
    }
    if (event.code === "KeyU" && event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (!event.repeat) markAllRead();
    }
  };

  return { onAssistantKeyDown, onAgentStepKeyDownCapture, onNavigationKeyDown, onSearchKeyDown };
}
