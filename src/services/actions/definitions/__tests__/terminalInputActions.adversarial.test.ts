import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const contextMenuMock = vi.hoisted(() => ({ openPanelContextMenu: vi.fn() }));
const terminalInstanceMock = vi.hoisted(() => ({
  get: vi.fn(),
  notifyUserInput: vi.fn(),
}));
const terminalClientMock = vi.hoisted(() => ({ write: vi.fn() }));
const bracketedMock = vi.hoisted(() => ({
  formatWithBracketedPaste: vi.fn((t: string) => `<BP>${t}</BP>`),
}));
const sendToAgentMock = vi.hoisted(() => ({ openSendToAgentPalette: vi.fn() }));
const terminalInputStoreMock = vi.hoisted(() => ({
  triggerStashInput: vi.fn(),
  triggerPopStash: vi.fn(),
}));
const fleetArmingMock = vi.hoisted(() => ({
  useFleetArmingStore: {
    getState: vi.fn(() => ({
      armId: vi.fn(),
      disarmId: vi.fn(),
      clear: vi.fn(),
      armByState: vi.fn(),
      armAll: vi.fn(),
    })),
  },
  isFleetArmEligible: vi.fn(() => false),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));
vi.mock("@/lib/panelContextMenu", () => contextMenuMock);
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: terminalInstanceMock,
}));
vi.mock("@/clients", () => ({ terminalClient: terminalClientMock }));
vi.mock("@shared/utils/terminalInputProtocol", () => bracketedMock);
vi.mock("@/hooks/useSendToAgentPalette", () => sendToAgentMock);
vi.mock("@/store/terminalInputStore", () => terminalInputStoreMock);
vi.mock("@/store/fleetArmingStore", () => fleetArmingMock);
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => kind === "terminal" || kind === "agent",
}));

import { registerTerminalInputActions } from "../terminalInputActions";

type ManagedStub = {
  terminal?: {
    getSelection: () => string;
    modes: { bracketedPasteMode: boolean };
  };
  isInputLocked?: boolean;
};

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: unknown) => Promise<unknown>;
  callbacks: ActionCallbacks;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    getActiveWorktreeId: vi.fn(),
    onInject: vi.fn(),
  } as unknown as ActionCallbacks;
  registerTerminalInputActions(actions, callbacks);
  return {
    run: async (id: string, args?: unknown, ctx?: unknown) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      const def = factory() as AnyActionDefinition;
      return def.run(args, (ctx ?? {}) as never);
    },
    callbacks,
  };
}

function setPanelState(state: {
  focusedId?: string | null;
  panelsById?: Record<string, { isInputLocked?: boolean; kind?: string }>;
}) {
  panelStoreMock.getState.mockReturnValue({
    focusedId: state.focusedId ?? null,
    panelsById: state.panelsById ?? {},
  });
}

let clipboardText = "";
let clipboardReadRejects: Error | null = null;
const writeSpy = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.clearAllMocks();
  clipboardText = "";
  clipboardReadRejects = null;
  writeSpy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        readText: vi.fn(async () => {
          if (clipboardReadRejects) throw clipboardReadRejects;
          return clipboardText;
        }),
        writeText: writeSpy,
      },
    },
    configurable: true,
  });
  bracketedMock.formatWithBracketedPaste.mockImplementation((t: string) => `<BP>${t}</BP>`);
});

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
});

describe("terminalInputActions adversarial", () => {
  it("paste with denied clipboard is side-effect free", async () => {
    clipboardReadRejects = new Error("NotAllowedError");
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { isInputLocked: false, kind: "terminal" } },
    });
    const managed: ManagedStub = {
      terminal: { getSelection: () => "", modes: { bracketedPasteMode: false } },
      isInputLocked: false,
    };
    terminalInstanceMock.get.mockReturnValue(managed);

    const { run } = setupActions();
    await run("terminal.paste");

    expect(terminalClientMock.write).not.toHaveBeenCalled();
    expect(terminalInstanceMock.notifyUserInput).not.toHaveBeenCalled();
  });

  it("paste is blocked when the panel reports isInputLocked", async () => {
    clipboardText = "secret";
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { isInputLocked: true, kind: "terminal" } },
    });
    terminalInstanceMock.get.mockReturnValue({
      terminal: { getSelection: () => "", modes: { bracketedPasteMode: false } },
      isInputLocked: false,
    });

    const { run } = setupActions();
    await run("terminal.paste");

    expect(terminalClientMock.write).not.toHaveBeenCalled();
    expect(terminalInstanceMock.notifyUserInput).not.toHaveBeenCalled();
  });

  it("paste is blocked when the managed terminal reports isInputLocked", async () => {
    clipboardText = "secret";
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { isInputLocked: false, kind: "terminal" } },
    });
    terminalInstanceMock.get.mockReturnValue({
      terminal: { getSelection: () => "", modes: { bracketedPasteMode: false } },
      isInputLocked: true,
    });

    const { run } = setupActions();
    await run("terminal.paste");

    expect(terminalClientMock.write).not.toHaveBeenCalled();
  });

  it("paste in bracketed-paste mode writes the bracketed-formatted payload", async () => {
    clipboardText = "hello\nworld";
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { isInputLocked: false, kind: "terminal" } },
    });
    terminalInstanceMock.get.mockReturnValue({
      terminal: { getSelection: () => "", modes: { bracketedPasteMode: true } },
      isInputLocked: false,
    });

    const { run } = setupActions();
    await run("terminal.paste");

    expect(bracketedMock.formatWithBracketedPaste).toHaveBeenCalledWith("hello\nworld");
    expect(terminalClientMock.write).toHaveBeenCalledWith("t1", "<BP>hello\nworld</BP>");
    expect(terminalInstanceMock.notifyUserInput).toHaveBeenCalledWith("t1");
  });

  it("paste without bracketed mode normalizes CRLF/LF to CR", async () => {
    clipboardText = "a\r\nb\nc";
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { isInputLocked: false, kind: "terminal" } },
    });
    terminalInstanceMock.get.mockReturnValue({
      terminal: { getSelection: () => "", modes: { bracketedPasteMode: false } },
      isInputLocked: false,
    });

    const { run } = setupActions();
    await run("terminal.paste");

    expect(terminalClientMock.write).toHaveBeenCalledWith("t1", "a\rb\rc");
  });

  it("paste with empty clipboard does not call write or notifyUserInput", async () => {
    clipboardText = "";
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { isInputLocked: false, kind: "terminal" } },
    });
    terminalInstanceMock.get.mockReturnValue({
      terminal: { getSelection: () => "", modes: { bracketedPasteMode: false } },
      isInputLocked: false,
    });

    const { run } = setupActions();
    await run("terminal.paste");

    expect(terminalClientMock.write).not.toHaveBeenCalled();
    expect(terminalInstanceMock.notifyUserInput).not.toHaveBeenCalled();
  });

  it("sendToAgent ignores non-PTY panels like browser", async () => {
    setPanelState({
      focusedId: "b1",
      panelsById: { b1: { kind: "browser" } },
    });

    const { run } = setupActions();
    await run("terminal.sendToAgent");

    expect(sendToAgentMock.openSendToAgentPalette).not.toHaveBeenCalled();
  });

  it("sendToAgent opens the palette for a PTY-backed panel", async () => {
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { kind: "terminal" } },
    });

    const { run } = setupActions();
    await run("terminal.sendToAgent");

    expect(sendToAgentMock.openSendToAgentPalette).toHaveBeenCalledWith("t1");
  });

  it("copy with empty selection does not write to clipboard", async () => {
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { kind: "terminal" } },
    });
    terminalInstanceMock.get.mockReturnValue({
      terminal: { getSelection: () => "", modes: { bracketedPasteMode: false } },
    });

    const { run } = setupActions();
    await run("terminal.copy");

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("copy with no focused terminal does not crash and does not call the service", async () => {
    setPanelState({ focusedId: null, panelsById: {} });

    const { run } = setupActions();
    await run("terminal.copy");

    expect(terminalInstanceMock.get).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("copyLink writes the URL to clipboard even when navigator.clipboard.writeText rejects", async () => {
    writeSpy.mockRejectedValueOnce(new Error("denied"));

    const { run } = setupActions();

    await expect(run("terminal.copyLink", { url: "https://a.example" })).rejects.toThrow("denied");
    expect(writeSpy).toHaveBeenCalledWith("https://a.example");
  });

  describe("terminal.bulkCommand (fleet broadcast entry)", () => {
    it("arms the current worktree and performs no other store side effects", async () => {
      const armAll = vi.fn();
      fleetArmingMock.useFleetArmingStore.getState.mockReturnValue({
        armedIds: { size: 3 } as Set<string>,
        armAll,
      } as never);

      const { run } = setupActions();
      await run("terminal.bulkCommand");

      expect(armAll).toHaveBeenCalledWith("current");
      expect(armAll).toHaveBeenCalledTimes(1);
    });
  });

  describe("terminal.arm / disarm / disarmAll (MCP-exposed fleet primitives)", () => {
    it("arms an eligible terminal and echoes the POST-mutation armed set in order", async () => {
      // Stateful mock: armId mutates the same armOrder the run() echoes, so a
      // read-before-mutate regression (spreading armOrder before armId runs)
      // would surface as a stale echo here, not pass silently.
      const armOrder: string[] = ["t2"];
      const armId = vi.fn((id: string) => {
        armOrder.push(id);
      });
      fleetArmingMock.isFleetArmEligible.mockReturnValueOnce(true);
      fleetArmingMock.useFleetArmingStore.getState.mockReturnValue({ armId, armOrder } as never);
      setPanelState({ panelsById: { t1: { kind: "agent" } } });

      const { run } = setupActions();
      const result = await run("terminal.arm", { terminalId: "t1" });

      expect(armId).toHaveBeenCalledWith("t1");
      expect(result).toEqual({ armed: ["t2", "t1"] });
    });

    it("does not arm an ineligible terminal but still echoes the current armed set", async () => {
      const armOrder: string[] = ["existing"];
      const armId = vi.fn((id: string) => {
        armOrder.push(id);
      });
      fleetArmingMock.isFleetArmEligible.mockReturnValue(false);
      fleetArmingMock.useFleetArmingStore.getState.mockReturnValue({ armId, armOrder } as never);
      setPanelState({ panelsById: { browser: { kind: "browser" } } });

      const { run } = setupActions();
      const result = await run("terminal.arm", { terminalId: "browser" });

      expect(armId).not.toHaveBeenCalled();
      expect(result).toEqual({ armed: ["existing"] });
    });

    it("disarm removes the terminal and echoes the POST-mutation armed set", async () => {
      const armOrder: string[] = ["t1", "t2"];
      const disarmId = vi.fn((id: string) => {
        const i = armOrder.indexOf(id);
        if (i >= 0) armOrder.splice(i, 1);
      });
      fleetArmingMock.useFleetArmingStore.getState.mockReturnValue({ disarmId, armOrder } as never);

      const { run } = setupActions();
      const result = await run("terminal.disarm", { terminalId: "t1" });

      expect(disarmId).toHaveBeenCalledWith("t1");
      expect(result).toEqual({ armed: ["t2"] });
    });

    it("disarmAll clears the set and echoes the now-empty armed set", async () => {
      const armOrder: string[] = ["t1", "t2"];
      const clear = vi.fn(() => {
        armOrder.length = 0;
      });
      fleetArmingMock.useFleetArmingStore.getState.mockReturnValue({ clear, armOrder } as never);

      const { run } = setupActions();
      const result = await run("terminal.disarmAll");

      expect(clear).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ armed: [] });
    });

    it("gates arm behind confirm but keeps disarm/disarmAll safe (#11346)", () => {
      const actions: ActionRegistry = new Map();
      registerTerminalInputActions(actions, {
        getActiveWorktreeId: vi.fn(),
        onInject: vi.fn(),
      } as unknown as ActionCallbacks);
      const arm = actions.get("terminal.arm")!() as AnyActionDefinition;
      const disarm = actions.get("terminal.disarm")!() as AnyActionDefinition;
      const disarmAll = actions.get("terminal.disarmAll")!() as AnyActionDefinition;

      // Arming reroutes the user's next keystrokes to every armed terminal, so
      // an agent/MCP caller must clear the host confirm gate before it can
      // silently repoint the broadcast set; disarming only shrinks the set (the
      // recovery path) and stays confirm-free.
      expect(arm.danger).toBe("confirm");
      expect(arm.dangerRationale?.trim()).toBeTruthy();
      expect(disarm.danger).toBe("safe");
      expect(disarmAll.danger).toBe("safe");
    });
  });

  describe("terminal.inject target binding (#11346)", () => {
    it("agent dispatch without terminalId fails closed and never injects", async () => {
      const { run, callbacks } = setupActions();
      (callbacks.getActiveWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue("wt-1");

      // Matched on the distinctive guard sentence, not a bare /terminalId/, so
      // this stays honest if inject's optional-chained read ever becomes a
      // plain destructure — that raises a TypeError naming terminalId, which a
      // looser matcher would accept as a guard hit.
      await expect(run("terminal.inject", undefined, { dispatchSource: "agent" })).rejects.toThrow(
        /requires an explicit `terminalId` when dispatched by an agent or MCP client/
      );
      expect(callbacks.onInject).not.toHaveBeenCalled();
    });

    it("agent dispatch with an explicit terminalId forwards it to the injection callback", async () => {
      const { run, callbacks } = setupActions();
      (callbacks.getActiveWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue("wt-1");

      await run("terminal.inject", { terminalId: "term-9" }, { dispatchSource: "agent" });

      expect(callbacks.onInject).toHaveBeenCalledWith("wt-1", "term-9");
    });

    it("interactive (keybinding) dispatch may omit terminalId and preserves the focus fallback", async () => {
      const { run, callbacks } = setupActions();
      (callbacks.getActiveWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue("wt-1");

      // No dispatchSource / a non-agent source: the action forwards an undefined
      // target so the hook falls back to the focused terminal.
      await run("terminal.inject", undefined, { dispatchSource: "keybinding" });

      expect(callbacks.onInject).toHaveBeenCalledWith("wt-1", undefined);
    });
  });

  // The same ambient-focus fallback as terminal.inject, on the rest of this
  // file's target-taking actions (#11532). None are on an agent/MCP allowlist
  // today, so these guards are defense in depth against a future exposure.
  describe("agent dispatch target binding (#11532)", () => {
    // Matched in full rather than on /terminalId/ alone, so an unguarded-args
    // TypeError (whose message also names terminalId) can't pass as a guard hit.
    const UNBOUND_TARGET =
      /requires an explicit `terminalId` when dispatched by an agent or MCP client/;

    // noTarget mirrors what ActionService really passes: undefined for a
    // `.optional()` schema, {} for a plain object schema it coerces into.
    const GUARDED = [
      { id: "terminal.copy", noTarget: undefined, effect: () => writeSpy },
      { id: "terminal.paste", noTarget: undefined, effect: () => terminalClientMock.write },
      {
        id: "terminal.contextMenu",
        noTarget: {},
        effect: () => contextMenuMock.openPanelContextMenu,
      },
      {
        id: "terminal.sendToAgent",
        noTarget: {},
        effect: () => sendToAgentMock.openSendToAgentPalette,
      },
    ] as const;

    function seedFocusedTerminal() {
      setPanelState({
        focusedId: "focused-panel",
        panelsById: {
          "focused-panel": { isInputLocked: false, kind: "terminal" },
          "explicit-panel": { isInputLocked: false, kind: "terminal" },
        },
      });
      terminalInstanceMock.get.mockReturnValue({
        terminal: { getSelection: () => "selected text", modes: { bracketedPasteMode: false } },
        isInputLocked: false,
      } satisfies ManagedStub);
    }

    it.each(GUARDED)(
      "$id rejects agent dispatch that names no terminal, and never touches the focused one",
      async ({ id, noTarget, effect }) => {
        clipboardText = "clipboard text";
        seedFocusedTerminal();
        const { run } = setupActions();

        await expect(run(id, noTarget, { dispatchSource: "agent" })).rejects.toThrow(
          UNBOUND_TARGET
        );

        expect(effect()).not.toHaveBeenCalled();
      }
    );

    it("keeps the focus fallback for interactive contextMenu dispatch", async () => {
      seedFocusedTerminal();
      const { run } = setupActions();

      await run("terminal.contextMenu", {}, { dispatchSource: "keybinding" });

      expect(contextMenuMock.openPanelContextMenu).toHaveBeenCalledWith("focused-panel");
    });

    it("lets agent dispatch through once it names a terminal, ignoring focus", async () => {
      seedFocusedTerminal();
      const { run } = setupActions();

      await run(
        "terminal.contextMenu",
        { terminalId: "explicit-panel" },
        {
          dispatchSource: "agent",
        }
      );

      expect(contextMenuMock.openPanelContextMenu).toHaveBeenCalledWith("explicit-panel");
    });
  });
});
