import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalInstanceMock = vi.hoisted(() => ({ get: vi.fn() }));
const copyCleanSelection = vi.hoisted(() =>
  vi.fn<(selection: string, cleaned: string, claudeTerminalId: string | null) => void>()
);
const cleanTerminalSelection = vi.hoisted(() =>
  vi.fn((terminal: { getSelection: () => string }) => `clean:${terminal.getSelection()}`)
);

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  createTerminalPaintPlane: () => terminalInstanceMock,
}));
vi.mock("@/services/terminal/copyCleanSelection", () => ({ copyCleanSelection }));
vi.mock("@/services/terminal/cleanTerminalCopy", () => ({ cleanTerminalSelection }));

import { registerTerminalInputActions } from "../terminalInputActions";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { DENY_PLUGIN_DISPATCH_ACTION_IDS } from "@shared/config/actionIds";

beforeAll(async () => {
  await loadTerminalService();
});

function copyClean(): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerTerminalInputActions(actions, {} as ActionCallbacks);
  return actions.get("terminal.copyClean")!() as AnyActionDefinition;
}

function seed(
  selections: Record<string, string>,
  panels: Record<string, Record<string, unknown>>,
  focusedId: string | null
) {
  panelStoreMock.getState.mockReturnValue({ focusedId, panelsById: panels });
  terminalInstanceMock.get.mockImplementation((id: string) =>
    id in selections
      ? {
          terminal: { getSelection: () => selections[id] },
          commandLinksDisposable: null,
        }
      : undefined
  );
}

describe("terminal.copyClean (#18132)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies the focused terminal's selection cleaned when a shortcut names no terminal", async () => {
    seed(
      { focused: "  focused text  ", other: "other text" },
      { focused: { id: "focused", kind: "terminal" }, other: { id: "other", kind: "terminal" } },
      "focused"
    );

    await copyClean().run(undefined, { dispatchSource: "user" } as never);

    expect(copyCleanSelection).toHaveBeenCalledTimes(1);
    expect(copyCleanSelection).toHaveBeenCalledWith(
      "  focused text  ",
      "clean:  focused text  ",
      null
    );
  });

  it("copies the named terminal's selection, not the focused one's", async () => {
    seed(
      { focused: "focused text", named: "named text" },
      { focused: { id: "focused", kind: "terminal" }, named: { id: "named", kind: "terminal" } },
      "focused"
    );

    await copyClean().run({ terminalId: "named" }, {} as never);

    expect(copyCleanSelection).toHaveBeenCalledWith("named text", "clean:named text", null);
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

    await copyClean().run(undefined, {} as never);

    expect(cleanTerminalSelection).not.toHaveBeenCalled();
    expect(copyCleanSelection).not.toHaveBeenCalled();
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

  it("is closed to plugin dispatch, like terminal.copy (#13155)", () => {
    expect(copyClean().denyPluginDispatch).toBe(true);
    expect(DENY_PLUGIN_DISPATCH_ACTION_IDS).toContain("terminal.copyClean");
  });
});
