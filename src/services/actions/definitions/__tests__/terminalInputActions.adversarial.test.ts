import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDefinition } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

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
      const def = factory() as ActionDefinition<unknown, unknown>;
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

  it("sendToAgent ignores non-PTY panels like browser/notes", async () => {
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
});
