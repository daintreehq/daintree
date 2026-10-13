// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { Compartment } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { ITheme } from "@xterm/xterm";
import type { SlashCommand } from "@shared/types";
import { recordBuiltCompartmentConfig, useCompartmentDriver } from "../useCompartmentDriver";
import { useEditorCompartments } from "../useEditorCompartments";
import { useEditorFactory } from "../useEditorFactory";

function makeCompartment(name: string) {
  const ref = { current: new Compartment() };
  const reconfigure = vi.fn((ext: unknown) => ({ name, ext }));
  ref.current.reconfigure = reconfigure as unknown as Compartment["reconfigure"];
  return { ref, reconfigure };
}

function makeView() {
  const dispatch = vi.fn();
  return { current: { dispatch, state: {} } as any, dispatch };
}

interface Props {
  disabled: boolean;
  isAutocompleteOpen: boolean;
  effectiveTheme: ITheme;
  placeholder: string;
  commandMap: Map<string, SlashCommand>;
}

const TOOLTIP_NAMES = [
  "tooltip",
  "fileChip",
  "imageChip",
  "fileDrop",
  "diffChip",
  "terminalChip",
  "selectionChip",
];

describe("useCompartmentDriver", () => {
  let c: Record<string, ReturnType<typeof makeCompartment>>;
  let view: ReturnType<typeof makeView>;
  const baseProps: Props = {
    disabled: false,
    isAutocompleteOpen: false,
    effectiveTheme: {},
    placeholder: "Ask anything",
    commandMap: new Map(),
  };

  beforeEach(() => {
    c = Object.fromEntries(
      ["theme", "placeholder", "editable", "chip", ...TOOLTIP_NAMES].map((n) => [
        n,
        makeCompartment(n),
      ])
    );
    view = makeView();
  });

  // Mirrors useEditorFactory: the view is built from the mount props with chip
  // tooltips gated on `disabled` only.
  function render(initial: Partial<Props> = {}, { seed = true } = {}) {
    const props = { ...baseProps, ...initial };
    if (seed && view.current) {
      recordBuiltCompartmentConfig(view.current, { ...props, isAutocompleteOpen: false });
    }
    return renderHook(
      (props: Props) =>
        useCompartmentDriver({
          editorViewRef: view as any,
          themeCompartmentRef: c.theme!.ref as any,
          placeholderCompartmentRef: c.placeholder!.ref as any,
          editableCompartmentRef: c.editable!.ref as any,
          chipCompartmentRef: c.chip!.ref as any,
          tooltipCompartmentRef: c.tooltip!.ref as any,
          fileChipTooltipCompartmentRef: c.fileChip!.ref as any,
          imageChipTooltipCompartmentRef: c.imageChip!.ref as any,
          fileDropChipTooltipCompartmentRef: c.fileDrop!.ref as any,
          diffChipTooltipCompartmentRef: c.diffChip!.ref as any,
          terminalChipTooltipCompartmentRef: c.terminalChip!.ref as any,
          selectionChipTooltipCompartmentRef: c.selectionChip!.ref as any,
          ...props,
        }),
      { initialProps: props }
    );
  }

  function dispatchedEffects(call = -1): Array<{ name: string; ext: unknown }> {
    return view.dispatch.mock.calls.at(call)?.[0].effects ?? [];
  }

  it("does not reconfigure what the factory just built on mount", () => {
    render();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("does nothing when view is null", () => {
    view.current = null;
    const hook = render();
    hook.rerender({ ...baseProps, isAutocompleteOpen: true });
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("suppresses tooltips on mount when autocomplete is already open", () => {
    render({ isAutocompleteOpen: true });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const effects = dispatchedEffects();
    expect(effects.map((e) => e.name)).toEqual(TOOLTIP_NAMES);
    for (const effect of effects) expect(effect.ext).toEqual([]);
  });

  it("batches an autocomplete open/close into one transaction each", () => {
    const hook = render();
    hook.rerender({ ...baseProps, isAutocompleteOpen: true });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedEffects().map((e) => e.name)).toEqual(TOOLTIP_NAMES);
    for (const effect of dispatchedEffects()) expect(effect.ext).toEqual([]);

    hook.rerender({ ...baseProps, isAutocompleteOpen: false });
    expect(view.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedEffects().map((e) => e.name)).toEqual(TOOLTIP_NAMES);
    for (const effect of dispatchedEffects()) expect(effect.ext).not.toEqual([]);
  });

  it("toggles editable and suppresses tooltips together when disabled", () => {
    const hook = render();
    hook.rerender({ ...baseProps, disabled: true });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedEffects().map((e) => e.name)).toEqual(["editable", ...TOOLTIP_NAMES]);
    for (const effect of dispatchedEffects().slice(1)) expect(effect.ext).toEqual([]);
  });

  it("reapplies tooltips when disabled flips even while autocomplete keeps them suppressed", () => {
    const hook = render({ isAutocompleteOpen: true });
    view.dispatch.mockClear();
    hook.rerender({ ...baseProps, isAutocompleteOpen: true, disabled: true });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedEffects().map((e) => e.name)).toEqual(["editable", ...TOOLTIP_NAMES]);
    for (const effect of dispatchedEffects().slice(1)) expect(effect.ext).toEqual([]);
  });

  it("folds simultaneous prop changes into one transaction", () => {
    const hook = render();
    hook.rerender({
      ...baseProps,
      effectiveTheme: { background: "#000" },
      disabled: true,
      isAutocompleteOpen: true,
    });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedEffects().map((e) => e.name)).toEqual(["theme", "editable", ...TOOLTIP_NAMES]);
  });

  it("reconfigures every compartment when the view was not built by the factory", () => {
    render({}, { seed: false });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedEffects().map((e) => e.name)).toEqual([
      "theme",
      "placeholder",
      "editable",
      "chip",
      ...TOOLTIP_NAMES,
    ]);
  });

  it("reconfigures only the theme when the theme changes", () => {
    const hook = render();
    hook.rerender({ ...baseProps, effectiveTheme: { background: "#000" } });
    expect(dispatchedEffects().map((e) => e.name)).toEqual(["theme"]);
  });

  it("reconfigures only the placeholder when it changes", () => {
    const hook = render();
    hook.rerender({ ...baseProps, placeholder: "Other" });
    expect(dispatchedEffects().map((e) => e.name)).toEqual(["placeholder"]);
  });

  it("rebuilds the chip field and slash tooltip when commands change", () => {
    const hook = render();
    hook.rerender({ ...baseProps, commandMap: new Map() });
    expect(dispatchedEffects().map((e) => e.name)).toEqual(["chip", "tooltip"]);
  });

  it("keeps the slash tooltip suppressed when commands change while autocomplete is open", () => {
    const hook = render();
    hook.rerender({ ...baseProps, isAutocompleteOpen: true });
    hook.rerender({ ...baseProps, isAutocompleteOpen: true, commandMap: new Map() });
    const effects = dispatchedEffects();
    expect(effects.map((e) => e.name)).toEqual(["chip", "tooltip"]);
    expect(effects[1]!.ext).toEqual([]);
  });

  it("diffs a replacement view against the config it was built from", () => {
    const hook = render({ disabled: true });
    // terminalId changed: the factory built a new view from the same props and
    // the driver's dependencies did not change, so it did not run.
    const replacement = { dispatch: vi.fn(), state: {} };
    recordBuiltCompartmentConfig(replacement as any, {
      ...baseProps,
      disabled: true,
      isAutocompleteOpen: false,
    });
    view.current = replacement;
    hook.rerender({ ...baseProps, disabled: false });
    const effects = replacement.dispatch.mock.calls.at(-1)?.[0].effects ?? [];
    expect(effects.map((e: { name: string }) => e.name)).toEqual(["editable", ...TOOLTIP_NAMES]);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("suppresses tooltips on a replacement view built while autocomplete was open", () => {
    const hook = render();
    hook.rerender({ ...baseProps, isAutocompleteOpen: true });
    const replacement = { dispatch: vi.fn(), state: {} };
    recordBuiltCompartmentConfig(replacement as any, { ...baseProps, isAutocompleteOpen: false });
    view.current = replacement;
    hook.rerender({ ...baseProps, isAutocompleteOpen: true, placeholder: "New" });
    const effects = replacement.dispatch.mock.calls.at(-1)?.[0].effects ?? [];
    expect(effects.map((e: { name: string }) => e.name)).toEqual(["placeholder", ...TOOLTIP_NAMES]);
    for (const effect of effects.slice(1)) expect(effect.ext).toEqual([]);
  });
});

const THEME: ITheme = { background: "#000000", foreground: "#ffffff" };
const COMMANDS = new Map<string, SlashCommand>();

interface LiveProps {
  terminalId: string;
  disabled: boolean;
  isAutocompleteOpen: boolean;
  placeholder: string;
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

function mount(initial: Partial<LiveProps> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispatch = vi.spyOn(EditorView.prototype, "dispatch");
  let viewRef: React.RefObject<EditorView | null> = { current: null };
  const hook = renderHook(
    ({ terminalId, disabled, isAutocompleteOpen, placeholder }: LiveProps) => {
      const compartments = useEditorCompartments();
      const editorHostRef = useRef<HTMLDivElement | null>(host);
      const editorViewRef = useRef<EditorView | null>(null);
      viewRef = editorViewRef;
      const contextUpdateRef = useRef<(u: ViewUpdate) => void>(() => {});
      const keymapHandlersRef = useRef(null);
      useEditorFactory({
        terminalId,
        editorHostRef,
        editorViewRef,
        value: "",
        disabled,
        placeholder,
        effectiveTheme: THEME,
        commandMap: COMMANDS,
        compartments,
        contextUpdateRef,
        keymapHandlersRef,
        domEventHandlers: [],
        imagePasteExtension: [],
        filePasteExtension: [],
        plainPasteKeymap: [],
      });
      useCompartmentDriver({
        editorViewRef,
        ...compartments,
        effectiveTheme: THEME,
        placeholder,
        disabled,
        commandMap: COMMANDS,
        isAutocompleteOpen,
      });
    },
    {
      initialProps: {
        terminalId: "t1",
        disabled: false,
        isAutocompleteOpen: false,
        placeholder: "Ask anything",
        ...initial,
      },
    }
  );
  cleanup = () => {
    hook.unmount();
    host.remove();
  };
  return { hook, dispatch, view: () => viewRef.current! };
}

const editable = (view: EditorView) => view.state.facet(EditorView.editable);
const placeholderText = (view: EditorView) =>
  view.dom.querySelector(".cm-placeholder")?.textContent ?? null;

describe("useCompartmentDriver with a real editor", () => {
  it("does not dispatch on mount and keeps the factory's disabled state", () => {
    const { dispatch, view } = mount({ disabled: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(editable(view())).toBe(false);
  });

  it("applies prop changes after mount", () => {
    const { hook, view } = mount({ disabled: true });
    hook.rerender({
      terminalId: "t1",
      disabled: false,
      isAutocompleteOpen: false,
      placeholder: "Next",
    });
    expect(editable(view())).toBe(true);
    expect(placeholderText(view())).toBe("Next");
  });

  it("unlocks a view rebuilt for a new terminal", () => {
    const { hook, view } = mount({ disabled: true });
    const first = view();
    hook.rerender({
      terminalId: "t2",
      disabled: true,
      isAutocompleteOpen: false,
      placeholder: "Ask anything",
    });
    expect(view()).not.toBe(first);
    hook.rerender({
      terminalId: "t2",
      disabled: false,
      isAutocompleteOpen: false,
      placeholder: "Ask anything",
    });
    expect(editable(view())).toBe(true);
  });
});
