// @vitest-environment jsdom
import { createElement, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import {
  whenPluginUiReady,
  useDebouncedCallback,
  useDebouncedValue,
  useDisclosure,
  useHotkeys,
  useListNavigation,
  usePersistentViewState,
  useSelection,
  useUndoRedo,
} from "@daintreehq/plugin-ui";
import type { UseSelectionOptions } from "@daintreehq/plugin-ui";
import {
  PluginKitViewHostContext,
  type PluginKitViewHost,
} from "@/components/PluginKit/kitViewHost";
import {
  gestureCommand,
  reduceSelection,
  type SelectionContext,
  type SelectionState,
} from "../selection";
import { isTypingTarget, matchesHotkey, parseHotkey } from "../hotkeys";
import { createHistory, pushHistory, redoHistory, undoHistory } from "../undoRedo";
import { VIEW_STATE_KEY_PREFIX } from "../viewState";

beforeAll(async () => {
  // useHotkeys reads the host's bindings through the kit, and stays out until it is in.
  await whenPluginUiReady();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const IDS = ["a", "b", "c", "d", "e"];

function ctx(overrides: Partial<SelectionContext<string>> = {}): SelectionContext<string> {
  return { ids: IDS, single: false, blocked: () => false, ...overrides };
}

const empty: SelectionState<string> = { selected: [], anchor: null, base: [] };

describe("reduceSelection", () => {
  it("replaces the selection on a plain select and sets the anchor", () => {
    const next = reduceSelection(empty, { type: "select", ids: ["c"] }, ctx());
    expect(next).toEqual({ selected: ["c"], anchor: "c", base: [] });
  });

  it("toggles rows on and off, moving the anchor to the toggled row", () => {
    let state = reduceSelection(empty, { type: "select", ids: ["a"] }, ctx());
    state = reduceSelection(state, { type: "toggle", id: "c" }, ctx());
    expect(state.selected).toEqual(["a", "c"]);
    expect(state.anchor).toBe("c");
    state = reduceSelection(state, { type: "toggle", id: "a" }, ctx());
    expect(state.selected).toEqual(["c"]);
    expect(state.anchor).toBe("a");
  });

  it("selects a range from the anchor in either direction", () => {
    const anchored = reduceSelection(empty, { type: "select", ids: ["d"] }, ctx());
    expect(
      reduceSelection(anchored, { type: "range", id: "b", additive: false }, ctx()).selected
    ).toEqual(["b", "c", "d"]);
    expect(
      reduceSelection(anchored, { type: "range", id: "e", additive: false }, ctx()).selected
    ).toEqual(["d", "e"]);
  });

  it("replaces the last range on a second Shift-click, keeping the anchor", () => {
    let state = reduceSelection(empty, { type: "select", ids: ["b"] }, ctx());
    state = reduceSelection(state, { type: "range", id: "e", additive: false }, ctx());
    expect(state.selected).toEqual(["b", "c", "d", "e"]);
    state = reduceSelection(state, { type: "range", id: "c", additive: false }, ctx());
    expect(state.selected).toEqual(["b", "c"]);
    expect(state.anchor).toBe("b");
  });

  it("keeps rows Cmd-clicked before the range", () => {
    let state = reduceSelection(empty, { type: "select", ids: ["a"] }, ctx());
    state = reduceSelection(state, { type: "toggle", id: "c" }, ctx());
    state = reduceSelection(state, { type: "range", id: "e", additive: false }, ctx());
    expect(state.selected).toEqual(["a", "c", "d", "e"]);
    state = reduceSelection(state, { type: "range", id: "d", additive: false }, ctx());
    expect(state.selected).toEqual(["a", "c", "d"]);
  });

  it("adds a range to everything selected with Shift+Cmd", () => {
    let state = reduceSelection(empty, { type: "select", ids: ["e"] }, ctx());
    state = reduceSelection(state, { type: "toggle", id: "a" }, ctx());
    state = reduceSelection(state, { type: "range", id: "b", additive: true }, ctx());
    expect([...state.selected].sort()).toEqual(["a", "b", "e"]);
  });

  it("selects the target alone when there is no anchor", () => {
    expect(reduceSelection(empty, { type: "range", id: "c", additive: false }, ctx())).toEqual({
      selected: ["c"],
      anchor: "c",
      base: [],
    });
  });

  it("skips disabled rows in ranges and select-all, and ignores them otherwise", () => {
    const blocked = (id: string) => id === "c";
    const anchored = reduceSelection(empty, { type: "select", ids: ["a"] }, ctx({ blocked }));
    expect(
      reduceSelection(anchored, { type: "range", id: "e", additive: false }, ctx({ blocked }))
        .selected
    ).toEqual(["a", "b", "d", "e"]);
    expect(reduceSelection(empty, { type: "all" }, ctx({ blocked })).selected).toEqual([
      "a",
      "b",
      "d",
      "e",
    ]);
    expect(reduceSelection(anchored, { type: "toggle", id: "c" }, ctx({ blocked }))).toBe(anchored);
  });

  it("holds one row at most in single mode", () => {
    const single = ctx({ single: true });
    let state = reduceSelection(empty, { type: "select", ids: ["a", "b"] }, single);
    expect(state.selected).toEqual(["a"]);
    state = reduceSelection(state, { type: "range", id: "d", additive: false }, single);
    expect(state.selected).toEqual(["d"]);
    state = reduceSelection(state, { type: "toggle", id: "d" }, single);
    expect(state.selected).toEqual([]);
    expect(reduceSelection(state, { type: "all" }, single)).toBe(state);
  });

  it("clears everything, the anchor included", () => {
    const state = reduceSelection(empty, { type: "select", ids: ["a"] }, ctx());
    expect(reduceSelection(state, { type: "clear" }, ctx())).toEqual(empty);
  });
});

describe("gestureCommand", () => {
  it("reads Cmd on macOS and Ctrl elsewhere as the toggle modifier", () => {
    expect(gestureCommand("a", { metaKey: true }, true)).toEqual({ type: "toggle", id: "a" });
    expect(gestureCommand("a", { ctrlKey: true }, true)).toEqual({ type: "select", ids: ["a"] });
    expect(gestureCommand("a", { ctrlKey: true }, false)).toEqual({ type: "toggle", id: "a" });
    expect(gestureCommand("a", { metaKey: true }, false)).toEqual({ type: "select", ids: ["a"] });
  });

  it("reads Shift as a range, additive with the primary modifier, and Space as a toggle", () => {
    expect(gestureCommand("a", { shiftKey: true }, true)).toEqual({
      type: "range",
      id: "a",
      additive: false,
    });
    expect(gestureCommand("a", { shiftKey: true, metaKey: true }, true)).toEqual({
      type: "range",
      id: "a",
      additive: true,
    });
    expect(gestureCommand("a", { key: " " }, true)).toEqual({ type: "toggle", id: "a" });
    expect(gestureCommand("a", undefined, true)).toEqual({ type: "select", ids: ["a"] });
  });
});

describe("useSelection", () => {
  function setup(options: Partial<UseSelectionOptions<string>> = {}) {
    return renderHook((props: Partial<UseSelectionOptions<string>>) =>
      useSelection({ ids: IDS, ...options, ...props })
    );
  }

  it("works uncontrolled from defaultSelected, in row order", () => {
    const { result } = setup({ defaultSelected: ["d", "a"] });
    expect(result.current.selected).toEqual(["a", "d"]);
    expect(result.current.count).toBe(2);
    expect(result.current.isSelected("d")).toBe(true);
    act(() => result.current.toggle("b"));
    expect(result.current.selected).toEqual(["a", "b", "d"]);
  });

  it("reports every change in row order and follows a controlled value", () => {
    const onSelectedChange = vi.fn();
    const { result, rerender } = setup({ selected: ["b"], onSelectedChange });
    act(() => result.current.handleSelect("d", { shiftKey: true }));
    // No anchor yet: Shift-click on its own selects the row.
    expect(onSelectedChange).toHaveBeenLastCalledWith(["d"]);
    // The parent never took the change, so the selection is still its own.
    expect(result.current.selected).toEqual(["b"]);
    rerender({ selected: ["d"], onSelectedChange });
    act(() => result.current.handleSelect("b", { shiftKey: true }));
    expect(onSelectedChange).toHaveBeenLastCalledWith(["b", "c", "d"]);
  });

  it("lets two gestures in one handler build on each other", () => {
    const { result } = setup();
    act(() => {
      result.current.select("a");
      result.current.toggle("c");
      result.current.selectRange("e");
    });
    expect(result.current.selected).toEqual(["a", "c", "d", "e"]);
  });

  it("drops rows that leave the list from `selected` and brings them back", () => {
    const { result, rerender } = setup({ defaultSelected: ["b", "c"] });
    rerender({ ids: ["a", "c"] });
    expect(result.current.selected).toEqual(["c"]);
    expect(result.current.isSelected("b")).toBe(false);
    rerender({ ids: IDS });
    expect(result.current.selected).toEqual(["b", "c"]);
  });

  it("selects all, reports allSelected, and clears", () => {
    const { result } = setup({ isDisabled: (id) => id === "e" });
    act(() => result.current.selectAll());
    expect(result.current.selected).toEqual(["a", "b", "c", "d"]);
    expect(result.current.allSelected).toBe(true);
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
    expect(result.current.anchor).toBeNull();
  });

  it("ignores a plain click on a disabled row rather than clearing the selection", () => {
    const { result } = setup({ isDisabled: (id) => id === "c" });
    act(() => result.current.select("a"));
    act(() => result.current.handleSelect("c"));
    expect(result.current.selected).toEqual(["a"]);
    expect(result.current.anchor).toBe("a");
  });

  it("holds one row in single mode however the selection arrived", () => {
    const { result, rerender } = setup({ mode: "single", defaultSelected: ["b", "d"] });
    expect(result.current.selected).toEqual(["b"]);
    expect(result.current.isSelected("d")).toBe(false);
    rerender({ mode: "single", selected: ["e", "a"] });
    expect(result.current.count).toBe(1);
    act(() => result.current.handleSelect("c"));
    expect(result.current.selected).toEqual(["e"]);
  });

  it("extends only on a Shift navigation", () => {
    const { result } = setup();
    act(() => result.current.select("b"));
    act(() => result.current.handleNavigate("c"));
    expect(result.current.selected).toEqual(["b"]);
    act(() => result.current.handleNavigate("d", { shiftKey: true }));
    expect(result.current.selected).toEqual(["b", "c", "d"]);
  });

  it("ignores junk options rather than throwing", () => {
    const { result } = renderHook(() =>
      useSelection(
        JSON.parse('{"ids": ["a", {"x": 1}, 3, null], "selected": "nope", "isDisabled": 4}')
      )
    );
    expect(result.current.selected).toEqual([]);
    act(() => result.current.selectAll());
  });

  it("drives a keyboard list with useListNavigation: click, Cmd-click, Shift-click, Shift+Arrow", () => {
    function List() {
      const selection = useSelection({ ids: IDS });
      const nav = useListNavigation({
        count: IDS.length,
        onSelect: (index, event) => selection.handleSelect(IDS[index]!, event),
        onActiveIndexChange: (index, event) => selection.handleNavigate(IDS[index]!, event),
      });
      return createElement(
        "div",
        { ...nav.containerProps, "aria-multiselectable": true, "data-testid": "list" },
        IDS.map((id, index) =>
          createElement(
            "div",
            { key: id, ...nav.getRowProps(index), "aria-selected": selection.isSelected(id) },
            id
          )
        )
      );
    }
    render(createElement(List));
    const row = (id: string) => screen.getByText(id);
    const selectedIds = () => IDS.filter((id) => row(id).getAttribute("aria-selected") === "true");
    const mac = navigator.platform.toUpperCase().includes("MAC");
    const primary = mac ? { metaKey: true } : { ctrlKey: true };

    fireEvent.click(row("b"));
    expect(selectedIds()).toEqual(["b"]);
    fireEvent.click(row("d"), primary);
    expect(selectedIds()).toEqual(["b", "d"]);
    fireEvent.click(row("e"), { shiftKey: true });
    expect(selectedIds()).toEqual(["b", "d", "e"]);
    fireEvent.click(row("a"));
    fireEvent.keyDown(screen.getByTestId("list"), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(screen.getByTestId("list"), { key: "ArrowDown", shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b", "c"]);
    fireEvent.keyDown(screen.getByTestId("list"), { key: " " });
    expect(selectedIds()).toEqual(["a", "b"]);
  });
});

describe("parseHotkey and matchesHotkey", () => {
  const key = (init: Partial<KeyboardEvent>) => ({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });

  it("parses the app's notation and refuses chords and bare modifiers", () => {
    expect(parseHotkey("Cmd+Shift+Z")).toEqual({
      primary: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: "z",
    });
    expect(parseHotkey("Delete")?.key).toBe("delete");
    expect(parseHotkey("Cmd++")?.key).toBe("+");
    expect(parseHotkey("Space")?.key).toBe(" ");
    expect(parseHotkey("Cmd+K T")).toBeNull();
    expect(parseHotkey("Cmd+Shift")).toBeNull();
    expect(parseHotkey("Hyper+A")).toBeNull();
    expect(parseHotkey("")).toBeNull();
    expect(parseHotkey(42)).toBeNull();
  });

  it("reads Cmd as Command on macOS and Ctrl elsewhere", () => {
    const cmdA = parseHotkey("Cmd+A")!;
    expect(matchesHotkey(key({ key: "a", metaKey: true }), cmdA, true)).toBe(true);
    expect(matchesHotkey(key({ key: "a", ctrlKey: true }), cmdA, true)).toBe(false);
    expect(matchesHotkey(key({ key: "a", ctrlKey: true }), cmdA, false)).toBe(true);
    expect(matchesHotkey(key({ key: "a", metaKey: true }), cmdA, false)).toBe(false);
    const ctrlA = parseHotkey("Ctrl+A")!;
    expect(matchesHotkey(key({ key: "a", ctrlKey: true }), ctrlA, true)).toBe(true);
  });

  it("wants exactly the named modifiers", () => {
    const undo = parseHotkey("Cmd+Z")!;
    expect(matchesHotkey(key({ key: "z", metaKey: true, shiftKey: true }), undo, true)).toBe(false);
    expect(
      matchesHotkey(
        key({ key: "Z", metaKey: true, shiftKey: true }),
        parseHotkey("Cmd+Shift+Z")!,
        true
      )
    ).toBe(true);
    expect(matchesHotkey(key({ key: "Delete", altKey: true }), parseHotkey("Delete")!, true)).toBe(
      false
    );
  });

  it("matches a shifted punctuation combo by its physical key, and never adds Shift to Space", () => {
    expect(
      matchesHotkey(
        key({ key: ":", code: "Semicolon", shiftKey: true }),
        parseHotkey("Shift+;")!,
        true
      )
    ).toBe(true);
    expect(
      matchesHotkey(key({ key: "÷", code: "Slash", altKey: true }), parseHotkey("Alt+/")!, true)
    ).toBe(true);
    expect(matchesHotkey(key({ key: " ", shiftKey: true }), parseHotkey("Space")!, true)).toBe(
      false
    );
  });

  it("lets a punctuation key carry its own Shift, and falls back to the physical key under Option", () => {
    expect(matchesHotkey(key({ key: "?", shiftKey: true }), parseHotkey("?")!, true)).toBe(true);
    expect(
      matchesHotkey(key({ key: "π", code: "KeyP", altKey: true }), parseHotkey("Alt+P")!, true)
    ).toBe(true);
  });
});

describe("isTypingTarget", () => {
  it("counts text fields and editors, not buttons or checkboxes", () => {
    const text = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    const editor = document.createElement("div");
    editor.setAttribute("role", "textbox");
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(editor)).toBe(true);
    expect(isTypingTarget(box)).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("useHotkeys", () => {
  const mac = () => navigator.platform.toUpperCase().includes("MAC");
  const primary = () => (mac() ? { metaKey: true } : { ctrlKey: true });

  function Pane({
    onDelete,
    onAll,
    enabled,
    scoped,
  }: {
    onDelete: () => void;
    onAll?: () => boolean | void;
    enabled?: boolean;
    scoped?: boolean;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    useHotkeys(
      [
        { combo: "Delete", handler: onDelete },
        { combo: "Cmd+A", handler: onAll ?? (() => {}), allowInInput: false },
      ],
      { enabled, scope: scoped ? ref : undefined }
    );
    return createElement(
      "div",
      null,
      createElement(
        "div",
        { ref, "data-testid": "scope" },
        createElement("button", { type: "button" }, "inside"),
        createElement("input", { "aria-label": "Search" })
      ),
      createElement("button", { type: "button" }, "outside")
    );
  }

  it("runs the matching handler and prevents the default", () => {
    const onDelete = vi.fn();
    render(createElement(Pane, { onDelete }));
    const inside = screen.getByRole("button", { name: "inside" });
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    inside.dispatchEvent(event);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves the default alone when the handler returns false", () => {
    const onAll = vi.fn(() => false);
    render(createElement(Pane, { onDelete: () => {}, onAll }));
    const event = new KeyboardEvent("keydown", {
      key: "a",
      ...primary(),
      bubbles: true,
      cancelable: true,
    });
    screen.getByRole("button", { name: "inside" }).dispatchEvent(event);
    expect(onAll).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores keys typed into a text field unless opted in", () => {
    const onDelete = vi.fn();
    render(createElement(Pane, { onDelete }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search" }), { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("takes keys in a text field for a binding that opts in", () => {
    const onEnter = vi.fn();
    function Field() {
      useHotkeys([{ combo: "Cmd+Enter", handler: onEnter, allowInInput: true }]);
      return createElement("input", { "aria-label": "Note" });
    }
    render(createElement(Field));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note" }), {
      key: "Enter",
      ...primary(),
    });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("counts a key from an overlay the view opened, by the view's React path", () => {
    const onDelete = vi.fn();
    const keyEvents = new WeakSet<Event>();
    const host: PluginKitViewHost = { root: { current: null }, keyEvents };
    render(
      createElement(
        PluginKitViewHostContext.Provider,
        { value: host },
        createElement(Pane, { onDelete })
      )
    );
    const target = screen.getByRole("button", { name: "outside" });
    const foreign = new KeyboardEvent("keydown", {
      key: "Delete",
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(foreign);
    expect(onDelete).not.toHaveBeenCalled();
    const own = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    keyEvents.add(own);
    target.dispatchEvent(own);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("only fires while focus is inside its scope", () => {
    const onDelete = vi.fn();
    render(createElement(Pane, { onDelete, scoped: true }));
    fireEvent.keyDown(screen.getByRole("button", { name: "outside" }), { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "inside" }), { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("scopes to the view's root inside a plugin view", () => {
    const onDelete = vi.fn();
    const root = { current: null as HTMLElement | null };
    const host: PluginKitViewHost = { root };
    function View() {
      return createElement(
        "div",
        { ref: (node: HTMLDivElement | null) => void (root.current = node) },
        createElement(Pane, { onDelete })
      );
    }
    render(
      createElement(
        "div",
        null,
        createElement(PluginKitViewHostContext.Provider, { value: host }, createElement(View)),
        createElement("button", { type: "button" }, "another view")
      )
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "another view" }), { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "outside" }), { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("stands down when disabled, and for a key something else already handled", () => {
    const onDelete = vi.fn();
    const { rerender } = render(createElement(Pane, { onDelete, enabled: false }));
    fireEvent.keyDown(screen.getByRole("button", { name: "inside" }), { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
    rerender(createElement(Pane, { onDelete }));
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    event.preventDefault();
    screen.getByRole("button", { name: "inside" }).dispatchEvent(event);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("survives junk bindings", () => {
    function Junk() {
      useHotkeys(JSON.parse('[null, {"combo": 3}, {"combo": "Delete"}, "Delete"]'));
      return createElement("button", { type: "button" }, "x");
    }
    render(createElement(Junk));
    expect(() =>
      fireEvent.keyDown(screen.getByRole("button", { name: "x" }), { key: "Delete" })
    ).not.toThrow();
  });
});

describe("undo history", () => {
  const limits = { limit: 3, coalesceMs: 1000 };

  it("steps back and forward, and a push drops the redo trail", () => {
    let history = createHistory(0);
    history = pushHistory(history, 1, undefined, 0, limits);
    history = pushHistory(history, 2, undefined, 0, limits);
    history = undoHistory(history);
    expect(history.present).toBe(1);
    history = redoHistory(history);
    expect(history.present).toBe(2);
    history = undoHistory(history);
    history = pushHistory(history, 5, undefined, 0, limits);
    expect(history.future).toEqual([]);
    expect(history.past).toEqual([0, 1]);
  });

  it("merges pushes that share a key inside the window", () => {
    let history = createHistory("");
    history = pushHistory(history, "h", "typing", 0, limits);
    history = pushHistory(history, "he", "typing", 400, limits);
    history = pushHistory(history, "hey", "typing", 800, limits);
    expect(history.past).toEqual([""]);
    history = pushHistory(history, "hey!", "typing", 5000, limits);
    expect(history.past).toEqual(["", "hey"]);
  });

  it("drops the oldest step past the limit, and ignores a push of the same value", () => {
    let history = createHistory(0);
    for (let i = 1; i <= 5; i++) history = pushHistory(history, i, undefined, 0, limits);
    expect(history.past).toEqual([2, 3, 4]);
    expect(pushHistory(history, 5, undefined, 0, limits)).toBe(history);
    expect(undoHistory(createHistory(1))).toEqual(createHistory(1));
  });
});

describe("useUndoRedo", () => {
  it("pushes, undoes and redoes, returning the value it lands on", () => {
    const { result } = renderHook(() => useUndoRedo<string[]>(["a"]));
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.push((items) => [...items, "b"]));
    act(() => result.current.push((items) => [...items, "c"]));
    expect(result.current.value).toEqual(["a", "b", "c"]);
    let undone: string[] | undefined;
    act(() => {
      undone = result.current.undo();
    });
    expect(undone).toEqual(["a", "b"]);
    expect(result.current.canRedo).toBe(true);
    act(() => void result.current.redo());
    expect(result.current.value).toEqual(["a", "b", "c"]);
    act(() => result.current.reset());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.value).toEqual(["a", "b", "c"]);
  });

  it("builds several steps in one handler on each other", () => {
    const { result } = renderHook(() => useUndoRedo(0, { limit: 10 }));
    act(() => {
      result.current.push((n) => n + 1);
      result.current.push((n) => n + 1);
      result.current.undo();
    });
    expect(result.current.value).toBe(1);
  });

  it("undoes the newest step from a callback kept since an older render", () => {
    const { result } = renderHook(() => useUndoRedo(0));
    act(() => result.current.push(1));
    const keptUndo = result.current.undo;
    act(() => result.current.push(2));
    act(() => result.current.push(3));
    let restored: number | undefined;
    act(() => {
      restored = keptUndo();
    });
    expect(restored).toBe(2);
    expect(result.current.value).toBe(2);
    expect(result.current.canRedo).toBe(true);
  });

  it("resets to an explicit undefined, and to the current value with no argument", () => {
    const { result } = renderHook(() => useUndoRedo<string | undefined>("a"));
    act(() => result.current.push("b"));
    act(() => result.current.reset());
    expect(result.current.value).toBe("b");
    act(() => result.current.reset(undefined));
    expect(result.current.value).toBeUndefined();
    expect(result.current.canUndo).toBe(false);
  });

  it("returns undefined with nothing to undo or redo", () => {
    const { result } = renderHook(() => useUndoRedo(() => 1, JSON.parse('{"limit": "x"}')));
    expect(result.current.undo()).toBeUndefined();
    expect(result.current.redo()).toBeUndefined();
  });

  it("coalesces with the hook's window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { result } = renderHook(() => useUndoRedo("", { coalesceMs: 500 }));
    act(() => result.current.push("a", { coalesce: "type" }));
    vi.advanceTimersByTime(100);
    act(() => result.current.push("ab", { coalesce: "type" }));
    act(() => void result.current.undo());
    expect(result.current.value).toBe("");
  });
});

describe("useDisclosure", () => {
  it("opens, closes and toggles uncontrolled, reporting only real changes", () => {
    const onOpenChange = vi.fn();
    const { result } = renderHook(() => useDisclosure({ onOpenChange }));
    act(() => result.current.onOpen());
    expect(result.current.open).toBe(true);
    act(() => result.current.onOpen());
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    act(() => result.current.onToggle());
    expect(result.current.open).toBe(false);
    act(() => result.current.onOpenChange(true));
    expect(result.current.open).toBe(true);
  });

  it("composes several changes in one handler", () => {
    const { result } = renderHook(() => useDisclosure());
    act(() => {
      result.current.onOpen();
      result.current.onClose();
    });
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.onToggle();
      result.current.onToggle();
    });
    expect(result.current.open).toBe(false);
  });

  it("follows a controlled value", () => {
    const onOpenChange = vi.fn();
    const { result } = renderHook(() => useDisclosure({ open: false, onOpenChange }));
    act(() => result.current.onToggle());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(result.current.open).toBe(false);
  });
});

describe("useDebouncedValue", () => {
  it("settles once the value stops changing", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
      initialProps: { value: "a" },
    });
    rerender({ value: "ab" });
    act(() => void vi.advanceTimersByTime(150));
    rerender({ value: "abc" });
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current).toBe("a");
    act(() => void vi.advanceTimersByTime(60));
    expect(result.current).toBe("abc");
  });
});

describe("useDebouncedCallback", () => {
  it("runs once with the last arguments, and can flush or cancel", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 100));
    result.current("a");
    result.current("b");
    expect(result.current.isPending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith("b");
    result.current("c");
    result.current.flush();
    expect(spy).toHaveBeenLastCalledWith("c");
    result.current("d");
    result.current.cancel();
    vi.advanceTimersByTime(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("runs the leading call at once and caps a steady stream with maxWait", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedCallback(spy, 100, { leading: true, maxWait: 250 })
    );
    result.current(1);
    expect(spy).toHaveBeenCalledWith(1);
    for (let i = 2; i <= 6; i++) {
      vi.advanceTimersByTime(60);
      result.current(i);
    }
    // 300ms of calls 60ms apart: maxWait let one through at 250ms.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("always runs the latest callback, and takes a call from a layout effect on mount", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    function Probe({ tag }: { tag: string }) {
      const debounced = useDebouncedCallback((value: string) => seen.push(`${tag}:${value}`), 50);
      useLayoutEffect(() => debounced("mount"), [debounced]);
      return null;
    }
    const { rerender } = render(createElement(Probe, { tag: "first" }));
    rerender(createElement(Probe, { tag: "second" }));
    act(() => void vi.advanceTimersByTime(60));
    expect(seen).toEqual(["second:mount"]);
  });

  it("drops a pending call on unmount", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(spy));
    result.current();
    unmount();
    vi.advanceTimersByTime(1000);
    result.current();
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("usePersistentViewState", () => {
  function hostWith(initialArgs?: Record<string, unknown>) {
    const persistState = vi.fn(() => true);
    const host: PluginKitViewHost = { initialArgs, persistState, root: { current: null } };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(PluginKitViewHostContext.Provider, { value: host }, children);
    return { host, persistState, wrapper };
  }

  it("persists through the view's persistState under its own key", () => {
    const { persistState, wrapper } = hostWith();
    const { result } = renderHook(() => usePersistentViewState("tab", "all"), { wrapper });
    expect(result.current[0]).toBe("all");
    act(() => result.current[1]("starred"));
    expect(result.current[0]).toBe("starred");
    expect(persistState).toHaveBeenCalledWith({ [`${VIEW_STATE_KEY_PREFIX}tab`]: "starred" });
  });

  it("restores from the mount bag, and ignores a saved value of the wrong type", () => {
    const { wrapper } = hostWith({
      [`${VIEW_STATE_KEY_PREFIX}tab`]: "starred",
      [`${VIEW_STATE_KEY_PREFIX}width`]: "wide",
    });
    const { result } = renderHook(
      () => [usePersistentViewState("tab", "all")[0], usePersistentViewState("width", 240)[0]],
      { wrapper }
    );
    expect(result.current).toEqual(["starred", 240]);
  });

  it("shares a key across components and keeps it through an unmount", () => {
    const { wrapper } = hostWith();
    function Tabs({ label }: { label: string }) {
      const [tab, setTab] = usePersistentViewState("tab", "all");
      return createElement("button", { type: "button", onClick: () => setTab(label) }, `${tab}`);
    }
    function Pane() {
      const [shown, setShown] = useState(true);
      return createElement(
        "div",
        null,
        shown ? createElement(Tabs, { label: "recent" }) : null,
        createElement(Tabs, { label: "starred" }),
        createElement("button", { type: "button", onClick: () => setShown((s) => !s) }, "flip")
      );
    }
    render(createElement(Pane), { wrapper });
    fireEvent.click(screen.getAllByRole("button", { name: "all" })[0]!);
    expect(screen.getAllByRole("button", { name: "recent" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "flip" }));
    fireEvent.click(screen.getByRole("button", { name: "flip" }));
    expect(screen.getAllByRole("button", { name: "recent" })).toHaveLength(2);
  });

  it("keeps a set value of the declared type even when it differs from the default's", () => {
    const { persistState, wrapper } = hostWith({ [`${VIEW_STATE_KEY_PREFIX}filter`]: "open" });
    const { result } = renderHook(() => usePersistentViewState<string | null>("filter", "all"), {
      wrapper,
    });
    expect(result.current[0]).toBe("open");
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(persistState).toHaveBeenLastCalledWith({ [`${VIEW_STATE_KEY_PREFIX}filter`]: null });
  });

  it("keeps a value that is not JSON for the session only", () => {
    const { persistState, wrapper } = hostWith();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => usePersistentViewState<unknown>("big", null), { wrapper });
    act(() => result.current[1](10n));
    expect(result.current[0]).toBe(10n);
    expect(persistState).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("works outside a plugin view, in memory", () => {
    const { result } = renderHook(() => usePersistentViewState("detached-demo", 1));
    act(() => result.current[1]((n) => n + 1));
    expect(result.current[0]).toBe(2);
  });
});
