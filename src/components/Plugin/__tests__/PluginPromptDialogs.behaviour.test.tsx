// @vitest-environment jsdom
/**
 * The imperative plugin prompts (`host.showQuickPick` / `showInputBox` /
 * `showConfirm`) render third-party copy inside first-party chrome. These pin
 * the rules that keep that honest: the host names the plugin in every state,
 * the input takes typing on open, validation stays until the value is actually
 * fixed, and a multi-select exposes what is checked separately from where the
 * cursor is.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useEscapeStack: () => {}, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/store/paletteStore", () => {
  const usePaletteStore = (selector?: (s: { activePaletteId: null }) => unknown) =>
    selector ? selector({ activePaletteId: null }) : { activePaletteId: null };
  usePaletteStore.getState = () => ({ activePaletteId: null });
  return { usePaletteStore };
});

import { PluginInputBoxDialog } from "../PluginInputBoxDialog";
import { PluginQuickPickDialog } from "../PluginQuickPickDialog";
import { PluginConfirmPromptDialog } from "../PluginConfirmPromptDialog";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import type { PluginUiPromptParams, PluginUiPromptResultValue } from "@shared/types/pluginUiPrompt";

const PLUGIN_ID = "project__b6700c7a__acme.release-helper";

const CHECKS = [
  { id: "lint", label: "Lint", description: "eslint" },
  { id: "types", label: "Typecheck" },
  { id: "unit", label: "Unit tests", detail: "vitest, 4 shards" },
];

function seed(params: PluginUiPromptParams): ReturnType<typeof vi.fn> {
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([[PLUGIN_ID, { devMode: false, displayName: "Release Helper" }]]),
  });
  const resolve = vi.fn<(value: PluginUiPromptResultValue) => void>();
  usePluginPromptStore.setState({
    queue: [],
    current: { promptId: "p1", pluginId: PLUGIN_ID, params, resolve },
  });
  return resolve;
}

function field(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (!input) throw new Error("no input rendered");
  return input;
}

function combobox(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  if (!input) throw new Error("no combobox rendered");
  return input;
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function provenance(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="plugin-provenance"]');
}

function buttonNamed(name: RegExp): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    name.test(b.textContent ?? "")
  );
  if (!match) throw new Error(`no button matching ${name}`);
  return match;
}

function type(value: string): void {
  fireEvent.change(field(), { target: { value } });
}

afterEach(() => {
  cleanup();
  usePluginPromptStore.getState().reset();
  _resetPluginRuntimeStoreForTest();
});

describe("plugin prompts — attribution", () => {
  // The line the plugin cannot author must be present whatever the plugin
  // sent, and must never be the machine-local instance key.
  it.each<[string, PluginUiPromptParams, () => React.ReactElement]>([
    [
      "populated quick pick",
      { kind: "quickPick", items: CHECKS, options: {} },
      () => <PluginQuickPickDialog />,
    ],
    [
      "multi-select quick pick",
      { kind: "quickPick", items: CHECKS, options: { canSelectMany: true } },
      () => <PluginQuickPickDialog />,
    ],
    [
      "input box",
      { kind: "inputBox", options: { title: "Name it" } },
      () => <PluginInputBoxDialog />,
    ],
    [
      "confirm",
      { kind: "confirm", options: { title: "Publish release?" } },
      () => <PluginConfirmPromptDialog />,
    ],
  ])("names the plugin in a %s", (_what, params, dialog) => {
    seed(params);
    render(dialog());

    expect(provenance()?.textContent).toContain("Release Helper");
    expect(document.body.textContent).not.toContain("project__b6700c7a__");
  });

  it("keeps the attribution out of the input box body the plugin's copy fills", () => {
    seed({
      kind: "inputBox",
      options: { title: "Enter your token", prompt: "Paste it here", password: true },
    });
    render(<PluginInputBoxDialog />);

    const line = provenance()!;
    // The prompt is the plugin's; the attribution must sit in a different
    // region of the dialog so a prompt string cannot pass for it.
    const promptBlock = Array.from(document.querySelectorAll("p")).find(
      (p) => p.textContent === "Paste it here"
    )!;
    expect(promptBlock.parentElement?.contains(line)).toBe(false);
    // And a screen-reader user hears who is asking when the field takes focus.
    expect(field().getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
  });
});

describe("PluginInputBoxDialog", () => {
  // Only half of this is observable here: jsdom never lets the dialog's own
  // initial-focus pass win, so a regression to `initialFocus="first"` is caught
  // by plugin-prompt-review.spec.ts in a real browser instead.
  it("puts focus in the field on open", () => {
    seed({ kind: "inputBox", options: { title: "Name it" } });
    render(<PluginInputBoxDialog />);

    expect(document.activeElement).toBe(field());
  });

  it("keeps a rejected value's error until the value matches, then clears it", () => {
    const resolve = seed({
      kind: "inputBox",
      options: { title: "Tag", validationPattern: "^v\\d+$", validationMessage: "Use v1, v2…" },
    });
    render(<PluginInputBoxDialog />);

    type("2.5 final");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(resolve).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Use v1, v2…");
    expect(field().getAttribute("aria-invalid")).toBe("true");

    // An edit that is still wrong keeps the explanation.
    type("2.5 fina");
    expect(document.body.textContent).toContain("Use v1, v2…");

    // An edit that fixes it clears it at once.
    type("v2");
    expect(document.body.textContent).not.toContain("Use v1, v2…");
    expect(field().getAttribute("aria-invalid")).not.toBe("true");

    fireEvent.keyDown(field(), { key: "Enter" });
    expect(resolve).toHaveBeenCalledWith("v2");
  });

  it("ties the error to the field it describes", () => {
    seed({ kind: "inputBox", options: { validationPattern: "^\\d+$" } });
    render(<PluginInputBoxDialog />);

    type("abc");
    fireEvent.keyDown(field(), { key: "Enter" });

    const describedBy = field().getAttribute("aria-describedby")?.split(" ") ?? [];
    const error = Array.from(document.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("doesn't match")
    )!;
    expect(describedBy).toContain(error.id);
  });

  it("does not validate before the first submit", () => {
    seed({
      kind: "inputBox",
      options: { validationPattern: "^\\d+$", validationMessage: "Digits" },
    });
    render(<PluginInputBoxDialog />);

    type("abc");
    expect(document.body.textContent).not.toContain("Digits");
  });
});

describe("PluginQuickPickDialog — multi-select", () => {
  function renderMulti() {
    const resolve = seed({ kind: "quickPick", items: CHECKS, options: { canSelectMany: true } });
    render(<PluginQuickPickDialog />);
    return resolve;
  }

  it("exposes checked state on each option, separately from the cursor", () => {
    renderMulti();

    fireEvent.keyDown(combobox(), { key: "Enter" });
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });

    const [lint, types] = options();
    expect(lint!.getAttribute("aria-checked")).toBe("true");
    expect(types!.getAttribute("aria-checked")).toBe("false");
    // The cursor moved to Typecheck while Lint stayed checked: the two
    // signals must not share an attribute, or every checked row reads as
    // the one Enter acts on.
    expect(types!.getAttribute("data-selected")).toBe("true");
    expect(lint!.getAttribute("data-selected")).toBeNull();
    for (const option of options()) {
      expect(option.getAttribute("aria-selected")).not.toBe("true");
    }
  });

  it("submits the checked set from the keyboard chord and from the pointer", () => {
    const resolve = renderMulti();

    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "Enter" });
    act(() => {
      buttonNamed(/confirm 1 selected/i).click();
    });

    expect(resolve).toHaveBeenCalledWith([CHECKS[2]]);
  });

  it("accepts an empty selection as an answer, distinct from dismissing", () => {
    const resolve = renderMulti();

    fireEvent.keyDown(combobox(), { key: "Enter", metaKey: true });

    expect(resolve).toHaveBeenCalledWith([]);
  });
});

describe("PluginQuickPickDialog — single-select", () => {
  it("picks the row under the cursor", () => {
    const resolve = seed({ kind: "quickPick", items: CHECKS, options: {} });
    render(<PluginQuickPickDialog />);

    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "Enter" });

    expect(resolve).toHaveBeenCalledWith(CHECKS[1]);
  });

  it("treats Enter on a query that matched nothing as a no-op, not a cancel", () => {
    const resolve = seed({ kind: "quickPick", items: CHECKS, options: {} });
    render(<PluginQuickPickDialog />);

    fireEvent.change(combobox(), { target: { value: "zzzzqqq" } });
    expect(options()).toHaveLength(0);
    fireEvent.keyDown(combobox(), { key: "Enter" });

    expect(resolve).not.toHaveBeenCalled();
    expect(usePluginPromptStore.getState().current).not.toBeNull();
  });
});

describe("plugin prompts — attribution reaches assistive tech", () => {
  // The visible line lives in a footer a screen reader reaches last, if at
  // all, so each prompt's own name has to say who is asking.
  it("names the plugin in the quick pick dialog's accessible name", () => {
    seed({ kind: "quickPick", items: CHECKS, options: { title: "Pick one" } });
    render(<PluginQuickPickDialog />);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toContain("Release Helper");
  });

  it("names the plugin in the confirm dialog's accessible name", () => {
    seed({ kind: "confirm", options: { title: "Publish release?" } });
    render(<PluginConfirmPromptDialog />);

    const dialog = document.querySelector('[aria-modal="true"][aria-labelledby]');
    const titleId = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toContain("Release Helper");
  });
});

describe("PluginInputBoxDialog — keyboard and announcements", () => {
  it("does not submit on the Enter that commits an IME composition", () => {
    const resolve = seed({ kind: "inputBox", options: { title: "Name it" } });
    render(<PluginInputBoxDialog />);

    type("にほん");
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(resolve).not.toHaveBeenCalled();

    fireEvent.keyDown(field(), { key: "Enter" });
    expect(resolve).toHaveBeenCalledWith("にほん");
  });

  it("announces every rejected submit, not only the first", () => {
    const announce = vi.spyOn(useAnnouncerStore.getState(), "announce");
    seed({
      kind: "inputBox",
      options: { validationPattern: "^\\d+$", validationMessage: "Digits" },
    });
    render(<PluginInputBoxDialog />);

    type("abc");
    fireEvent.keyDown(field(), { key: "Enter" });
    type("12");
    type("12x");
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(announce.mock.calls.filter(([msg]) => msg === "Digits")).toHaveLength(2);
    announce.mockRestore();
  });
});

describe("PluginQuickPickDialog — listbox semantics", () => {
  it.each([
    [true, "true"],
    [false, null],
  ])("marks the listbox multiselectable only when canSelectMany is %s", (many, expected) => {
    seed({ kind: "quickPick", items: CHECKS, options: { canSelectMany: many } });
    render(<PluginQuickPickDialog />);

    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-multiselectable")).toBe(expected);
  });
});
