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
  run: (id: string, args?: unknown) => Promise<unknown>;
  callbacks: ActionCallbacks;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    getActiveWorktreeId: vi.fn(),
    onInject: vi.fn(),
  } as unknown as ActionCallbacks;
  registerTerminalInputActions(actions, callbacks);
  return {
    run: async (id: string, args?: unknown) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      const def = factory() as AnyActionDefinition;
      return def.run(args, {});
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

    it("keeps every arm/disarm primitive safe — they only edit the broadcast set", () => {
      const actions: ActionRegistry = new Map();
      registerTerminalInputActions(actions, {
        getActiveWorktreeId: vi.fn(),
        onInject: vi.fn(),
      } as unknown as ActionCallbacks);
      const arm = actions.get("terminal.arm")!() as AnyActionDefinition;
      const disarm = actions.get("terminal.disarm")!() as AnyActionDefinition;
      const disarmAll = actions.get("terminal.disarmAll")!() as AnyActionDefinition;

      // Arming/disarming routes the *next* input and mutates nothing on its own;
      // it's fully reversible via disarm, so none of it carries a confirm gate.
      expect(arm.danger).toBe("safe");
      expect(disarm.danger).toBe("safe");
      expect(disarmAll.danger).toBe("safe");
    });
  });
});
