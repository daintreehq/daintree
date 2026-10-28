import type { KeyboardEvent, RefObject } from "react";
import { isMac } from "@/lib/platform";
import {
  canopyCardDomId,
  type CanopyCardHandle,
  type CanopyCardHandlers,
  type CanopyPaneFocus,
} from "./CanopyCard";
import type { CanopyItem } from "./canopyModel";
import type { CanopyAssistantItem } from "./canopyAssistants";
import { stepEntry, type CanopyInboxEntry } from "./canopyInboxProjection";

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
  shownAssistants,
  navigation,
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
  selectAssistant,
  openAssistant,
  onOpen,
  askRename,
  toggleRead,
  markAllRead,
  onPastEnd,
}: {
  /** What the keyboard walks: the list, then the archived runs once shown. */
  visible: CanopyItem[];
  listed: CanopyItem[];
  shownAssistants: CanopyAssistantItem[];
  /** Every row the keyboard walks, in the order drawn: workers and assistants together. */
  navigation: CanopyInboxEntry[];
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
  selectAssistant: (id: string) => void;
  openAssistant: (item: CanopyAssistantItem) => void;
  onOpen: CanopyCardHandlers["onOpen"];
  askRename: (item: CanopyItem) => void;
  toggleRead: (item: CanopyItem) => void;
  markAllRead: () => void;
  /** Down off the inbox's last row, into the Trash below it: false when there is none. */
  onPastEnd?: () => boolean;
}) {
  const focusEntryNow = (entry: CanopyInboxEntry) =>
    entry.role === "worker" ? focusCardNow(entry.item.runId) : focusAssistantNow(entry.item.id);
  const keyOfWorker = (runId: string | undefined) =>
    runId === undefined
      ? null
      : (navigation.find((entry) => entry.role === "worker" && entry.item.runId === runId)?.key ??
        null);
  // The pane's own run, assistant or worker: where a step from the search starts.
  const shownKey = selectedAssistant?.id ?? keyOfWorker(focusedItem?.runId);
  // Down off the bottom of the inbox, from the row with that key: on to the Trash.
  const pastEnd = (key: string | null, event: KeyboardEvent<HTMLElement>): boolean => {
    if (key === null || navigation[navigation.length - 1]?.key !== key) return false;
    if (!onPastEnd?.()) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  // The assistant rows' own keys. They walk the same order as the worker rows,
  // so an assistant in the Needs you band steps into the workers around it.
  const onAssistantKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    assistant: CanopyAssistantItem
  ) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let next: CanopyInboxEntry | undefined;
    if (event.key === "ArrowDown" || event.key === "j") {
      if (pastEnd(assistant.id, event)) return;
      next = stepEntry(navigation, assistant.id, 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      if (navigation[0]?.key === assistant.id) {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
        return;
      }
      next = stepEntry(navigation, assistant.id, -1);
    } else if (event.key === "Home") {
      next = navigation[0];
    } else if (event.key === "End") {
      next = navigation[navigation.length - 1];
    } else if (event.key === "/") {
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      openAssistant(assistant);
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    focusEntryNow(next);
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
    // Back to the search: "/" from any row, or up off the top of the list.
    const search = searchRef.current;
    const activeKey = keyOfWorker(visible[activeIndex]?.runId);
    if (
      search &&
      (event.key === "/" || (event.key === "ArrowUp" && navigation[0]?.key === activeKey))
    ) {
      event.preventDefault();
      search.focus();
      if (event.key === "/") search.select();
      return;
    }
    let next: CanopyInboxEntry | undefined;
    if (event.key === "ArrowDown" || event.key === "j") {
      if (pastEnd(activeKey, event)) return;
      next = stepEntry(navigation, activeKey, 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      next = stepEntry(navigation, activeKey, -1);
    } else if (event.key === "Home") {
      next = navigation[0];
    } else if (event.key === "End") {
      next = navigation[navigation.length - 1];
    }
    if (next !== undefined) {
      event.preventDefault();
      focusEntryNow(next);
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
    // Nothing in the inbox: down from the search is down into the Trash.
    if (plain && event.key === "ArrowDown" && navigation.length === 0 && onPastEnd?.()) {
      event.preventDefault();
      return;
    }
    if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const target = stepEntry(navigation, shownKey, event.key === "ArrowDown" ? 1 : -1);
      if (target === undefined) return;
      if (target.role === "worker") selectNow(target.item.runId);
      else selectAssistant(target.item.id);
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
