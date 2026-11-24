// @vitest-environment jsdom
/**
 * The Copy clean text row's shortcut, drawn by the real context-menu primitives
 * so a rebind or an unbind shows the way it does in the app (#18132).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { primeRadix } from "@/components/ui/radix-loader";
import { keybindingService } from "@/services/KeybindingService";
import { comboToAriaKeyshortcuts, parseChord } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { TerminalSelectionMenuItems } from "../TerminalMenuItems";

const ACTION = "terminal.copyClean";

type ElectronWindow = { electron?: unknown };
let previousElectron: unknown;

beforeAll(async () => {
  await primeRadix();
  const win = window as unknown as ElectronWindow;
  previousElectron = win.electron;
  let saved: Record<string, string[]> = {};
  let revision = 0;
  const answer = () => ({ revision: ++revision, overrides: { ...saved } });
  win.electron = {
    keybinding: {
      setOverride: async (actionId: string, combo: string[]) => {
        saved = { ...saved, [actionId]: combo };
        return answer();
      },
      removeOverride: async (actionId: string) => {
        saved = { ...saved };
        delete saved[actionId];
        return answer();
      },
    },
  };
});

afterAll(() => {
  (window as unknown as ElectronWindow).electron = previousElectron;
});

afterEach(async () => {
  await act(() => keybindingService.removeOverride(ACTION));
  cleanup();
});

function openMenu(copyCleanKeybinding: string | undefined): Element {
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <div data-testid="target">target</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <TerminalSelectionMenuItems
          hasSelection
          hoveredUrl={null}
          hoveredUrlPluginName={null}
          hoveredFilePath={null}
          hoveredFileKind={null}
          hoveredFileScope={null}
          selectionFilePath={null}
          copyCleanKeybinding={copyCleanKeybinding}
          onOpenInFileBrowser={() => {}}
          onAction={() => {}}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
  act(() => {
    document
      .querySelector('[data-testid="target"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
  });
  return Array.from(document.querySelectorAll('[role="menuitem"]')).find((row) =>
    row.textContent?.includes("Copy clean text")
  )!;
}

function drawnKeys(row: Element): string[] {
  return Array.from(row.querySelectorAll("kbd")).map((k) => k.textContent ?? "");
}

describe("Copy clean text's shortcut in the terminal menu (#18132)", () => {
  it("shows a user's rebind, and nothing once the action is unbound", async () => {
    const row = openMenu(ACTION);

    await act(() => keybindingService.setOverride(ACTION, ["Cmd+Alt+J"]));
    expect(drawnKeys(row)).toEqual(parseChord("Cmd+Alt+J", isMac()).flat());
    expect(row.getAttribute("aria-keyshortcuts")).toBe(
      comboToAriaKeyshortcuts("Cmd+Alt+J", isMac())
    );

    await act(() => keybindingService.setOverride(ACTION, []));
    expect(drawnKeys(row)).toEqual([]);
    expect(row.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("advertises no shortcut where the menu's terminal keeps app keys out (Canopy)", async () => {
    await act(() => keybindingService.setOverride(ACTION, ["Cmd+Alt+J"]));
    const row = openMenu(undefined);
    expect(row.textContent).toContain("Copy clean text");
    expect(drawnKeys(row)).toEqual([]);
  });
});
