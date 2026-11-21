// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalInstanceMock = vi.hoisted(() => ({ get: vi.fn() }));
const order = vi.hoisted(() => [] as string[]);
const copyCleanSelection = vi.hoisted(() =>
  vi.fn<(selection: string, cleaned: string, claudeTerminalId: string | null) => void>(() => {
    order.push("copy");
  })
);
const cleanTerminalSelection = vi.hoisted(() =>
  vi.fn((terminal: { getSelection: () => string }) => `clean:${terminal.getSelection()}`)
);
const noteCopyFlashKeyboard = vi.hoisted(() =>
  vi.fn(() => {
    order.push("keyboard");
  })
);

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  createTerminalPaintPlane: () => terminalInstanceMock,
}));
vi.mock("@/services/terminal/copyCleanSelection", () => ({ copyCleanSelection }));
vi.mock("@/services/terminal/cleanTerminalCopy", () => ({ cleanTerminalSelection }));
vi.mock("@/lib/copyFlash", () => ({ noteCopyFlashKeyboard }));

import { registerTerminalInputActions } from "../terminalInputActions";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

beforeAll(async () => {
  await loadTerminalService();
});

function copyClean(): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerTerminalInputActions(actions, {} as ActionCallbacks);
  return actions.get("terminal.copyClean")!() as AnyActionDefinition;
}

/** A pane in the DOM: its frame, and the xterm whose textarea takes the keyboard. */
function mountPane(id: string | null): { element: HTMLElement; textarea: HTMLTextAreaElement } {
  const frame = document.createElement("div");
  if (id) frame.setAttribute("data-panel-id", id);
  const element = document.createElement("div");
  element.className = "xterm";
  const textarea = document.createElement("textarea");
  element.appendChild(textarea);
  frame.appendChild(element);
  document.body.appendChild(frame);
  return { element, textarea };
}

function seed(
  selections: Record<string, string>,
  panels: Record<string, Record<string, unknown>>,
  focusedId: string | null,
  elements: Record<string, HTMLElement> = {}
) {
  panelStoreMock.getState.mockReturnValue({ focusedId, panelsById: panels });
  terminalInstanceMock.get.mockImplementation((id: string) =>
    id in selections
      ? {
          terminal: { getSelection: () => selections[id], element: elements[id] },
          commandLinksDisposable: null,
        }
      : undefined
  );
}

const keybinding = { dispatchSource: "keybinding" } as never;

describe("terminal.copyClean (#18132)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("copies the focused terminal's selection cleaned when a shortcut names no terminal", async () => {
    const focused = mountPane("focused");
    seed(
      { focused: "  focused text  ", other: "other text" },
      { focused: { id: "focused", kind: "terminal" }, other: { id: "other", kind: "terminal" } },
      "focused",
      { focused: focused.element }
    );
    focused.textarea.focus();

    await copyClean().run(undefined, keybinding);

    expect(copyCleanSelection).toHaveBeenCalledTimes(1);
    expect(copyCleanSelection).toHaveBeenCalledWith(
      "  focused text  ",
      "clean:  focused text  ",
      null
    );
    // Marked before the copy snapshots where the flash goes.
    expect(order).toEqual(["keyboard", "copy"]);
  });

  it("copies from the pane whose terminal has the keyboard, not the store's focused panel", async () => {
    const focused = mountPane("focused");
    const dragged = mountPane("dragged");
    seed(
      { focused: "focused text", dragged: "dragged text" },
      {
        focused: { id: "focused", kind: "terminal" },
        dragged: { id: "dragged", kind: "terminal" },
      },
      "focused",
      { focused: focused.element, dragged: dragged.element }
    );
    dragged.textarea.focus();

    await copyClean().run(undefined, keybinding);

    expect(copyCleanSelection).toHaveBeenCalledWith("dragged text", "clean:dragged text", null);
  });

  it("copies nothing from a terminal outside any panel (the Assistant's)", async () => {
    const assistant = mountPane(null);
    seed({ focused: "focused text" }, { focused: { id: "focused", kind: "terminal" } }, "focused");
    assistant.textarea.focus();

    await copyClean().run(undefined, keybinding);

    expect(copyCleanSelection).not.toHaveBeenCalled();
  });

  it("falls back to the focused panel when no terminal has the keyboard (a chord's HUD)", async () => {
    const hud = document.createElement("input");
    document.body.appendChild(hud);
    seed({ focused: "focused text" }, { focused: { id: "focused", kind: "terminal" } }, "focused");
    hud.focus();

    await copyClean().run(undefined, keybinding);

    expect(copyCleanSelection).toHaveBeenCalledWith("focused text", "clean:focused text", null);
  });

  it("copies the named terminal's selection, whatever has the keyboard, and marks no keyboard copy", async () => {
    const focused = mountPane("focused");
    seed(
      { focused: "focused text", named: "named text" },
      { focused: { id: "focused", kind: "terminal" }, named: { id: "named", kind: "terminal" } },
      "focused",
      { focused: focused.element }
    );
    focused.textarea.focus();

    // Through the real schema, so a schema that dropped the field would fail here.
    const def = copyClean();
    await def.run(def.argsSchema!.parse({ terminalId: "named" }), {
      dispatchSource: "context-menu",
    } as never);

    expect(copyCleanSelection).toHaveBeenCalledWith("named text", "clean:named text", null);
    expect(noteCopyFlashKeyboard).not.toHaveBeenCalled();
  });

  it("hands a Claude Code pane's id on for the reply-span lookup", async () => {
    seed(
      { claude: "⏺ reply" },
      { claude: { id: "claude", kind: "terminal", launchAgentId: "claude" } },
      "claude"
    );

    await copyClean().run(undefined, {} as never);

    expect(copyCleanSelection).toHaveBeenCalledWith("⏺ reply", "clean:⏺ reply", "claude");
  });

  it("does nothing with no selection, leaving a reply-span copy still in flight alone", async () => {
    seed({ focused: "" }, { focused: { id: "focused", kind: "terminal" } }, "focused");

    await copyClean().run(undefined, keybinding);

    expect(cleanTerminalSelection).not.toHaveBeenCalled();
    expect(copyCleanSelection).not.toHaveBeenCalled();
    expect(noteCopyFlashKeyboard).not.toHaveBeenCalled();
  });

  it("does nothing with no focused terminal", async () => {
    seed({}, {}, null);

    await copyClean().run(undefined, {} as never);

    expect(terminalInstanceMock.get).not.toHaveBeenCalled();
    expect(copyCleanSelection).not.toHaveBeenCalled();
  });

  it("refuses an agent dispatch that names no terminal", async () => {
    seed({ focused: "focused text" }, { focused: { id: "focused", kind: "terminal" } }, "focused");

    await expect(copyClean().run(undefined, { dispatchSource: "agent" } as never)).rejects.toThrow(
      /requires an explicit `terminalId`/
    );
    expect(copyCleanSelection).not.toHaveBeenCalled();
  });
});
