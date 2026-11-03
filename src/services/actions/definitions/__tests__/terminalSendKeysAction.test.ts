// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: { write: vi.fn(), submit: vi.fn(), batchDoubleEscape: vi.fn() },
  projectClient: { getCurrent: vi.fn().mockResolvedValue(null) },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    flush: vi.fn(),
  },
}));
vi.mock("@/hooks/useSendToAgentPalette", () => ({ openSendToAgentPalette: vi.fn() }));
vi.mock("@/lib/panelContextMenu", () => ({ openPanelContextMenu: vi.fn() }));
vi.mock("@/services/terminal/TerminalInstanceService", () => {
  const terminalInstanceService = { get: vi.fn(), notifyUserInput: vi.fn() };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});
vi.mock("@/store/terminalInputStore", () => ({
  triggerPopStash: vi.fn(),
  triggerStashInput: vi.fn(),
}));
const gate = vi.hoisted(() => ({ block: null as null | { kind: string; hostName: string } }));
vi.mock("@/services/terminal/inputGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/terminal/inputGate")>()),
  getTerminalInputBlock: () => gate.block,
  getTerminalInputBlockMessage: (block: { hostName: string }) =>
    `Read-only until ${block.hostName} reconnects`,
}));

const { usePanelStore } = await import("@/store/panelStore");
const { terminalClient } = await import("@/clients");
const { registerTerminalInputActions } = await import("../terminalInputActions");

type ActionRegistry = Parameters<typeof registerTerminalInputActions>[0];

function sendKeys(args: Record<string, unknown>): Promise<unknown> {
  const registry: ActionRegistry = new Map();
  registerTerminalInputActions(registry, {
    getActiveWorktreeId: () => "wt-1",
    onInject: vi.fn(),
  } as never);
  const run = registry.get("terminal.sendKeys")!().run as (a: unknown, c: unknown) => unknown;
  return Promise.resolve(run(args, {}));
}

function agentPanel(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "t1",
    title: "t1",
    kind: "terminal",
    detectedAgentId: "claude",
    location: "grid",
    hasPty: true,
    ...overrides,
  } as PtyPanelData;
}

let screen: string | null;
const getSerializedState = vi.fn(async () => (screen === null ? null : { data: screen }));

async function press(keys: string[]): Promise<unknown> {
  const result = sendKeys({ terminalId: "t1", keys });
  const settled = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.advanceTimersByTimeAsync(2_000);
  const outcome = await settled;
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

describe("terminal.sendKeys result honesty (#16209)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(terminalClient.write).mockReset();
    gate.block = null;
    screen = "❯ Keep auto (1m tokens)\n";
    getSerializedState.mockClear();
    (window as unknown as { electron: unknown }).electron = {
      terminal: { getSerializedState },
    };
    usePanelStore.setState({ panelsById: { t1: agentPanel() }, panelIds: ["t1"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the screen didn't change when the keys left it as it was", async () => {
    await expect(press(["Escape"])).resolves.toMatchObject({
      keys: ["Escape"],
      screen: "❯ Keep auto (1m tokens)",
      screenChanged: false,
    });
  });

  it("says it changed when the read after the keys differs", async () => {
    vi.mocked(terminalClient.write).mockImplementation(() => {
      screen = "❯ \n";
    });
    await expect(press(["Escape"])).resolves.toMatchObject({ screenChanged: true });
  });

  it("leaves it out when a read is missing", async () => {
    screen = null;
    const result = await press(["Escape"]);
    expect(result).not.toHaveProperty("screenChanged");
    expect(result).not.toHaveProperty("screen");
  });

  it("refuses keys that would never leave the renderer, rather than reporting them pressed", async () => {
    gate.block = { kind: "disconnected", hostName: "studio" };
    await expect(press(["Escape"])).rejects.toThrow(
      "Terminal t1 takes no input right now (Read-only until studio reconnects). Nothing was pressed."
    );
    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("stops at a lock taken while the screen was read before the keys", async () => {
    getSerializedState.mockImplementationOnce(async () => {
      usePanelStore.setState({ panelsById: { t1: agentPanel({ isInputLocked: true }) } });
      return screen === null ? null : { data: screen };
    });
    await expect(press(["Enter"])).rejects.toThrow(
      "Terminal t1 has its input locked. Nothing was pressed."
    );
    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("says how many keys went in when input is blocked partway", async () => {
    vi.mocked(terminalClient.write).mockImplementation(() => {
      gate.block = { kind: "disconnected", hostName: "studio" };
    });
    await expect(press(["Down", "Enter"])).rejects.toThrow("1 of 2 keys were sent (Down)");
    expect(terminalClient.write).toHaveBeenCalledTimes(1);
  });
});
