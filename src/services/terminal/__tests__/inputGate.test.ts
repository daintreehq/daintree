import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = {
  write: vi.fn(),
  submit: vi.fn(async () => undefined),
  sendKey: vi.fn(),
  broadcastWrite: vi.fn(),
  batchDoubleEscape: vi.fn(),
  resize: vi.fn(),
};

let gate: typeof import("../inputGate");
let terminalClient: typeof import("@/clients/terminalClient").terminalClient;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const windowMock: Record<string, unknown> = {
    top: null,
    electron: { terminal },
    location: { origin: "http://localhost", protocol: "http:" },
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
  };
  windowMock.top = windowMock;
  Reflect.set(globalThis, "window", windowMock);
  gate = await import("../inputGate");
  terminalClient = (await import("@/clients/terminalClient")).terminalClient;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function typeEverything() {
  terminalClient.write("t-1", "ls\r");
  terminalClient.sendKey("t-1", "ctrl+c");
  terminalClient.broadcast(["t-1", "t-2"], "y");
  terminalClient.batchDoubleEscape(["t-1"]);
}

describe("terminal input gate", () => {
  it("sends input untouched when nothing blocks it", async () => {
    typeEverything();
    await terminalClient.submit("t-1", "echo hi");
    expect(terminal.write).toHaveBeenCalledWith("t-1", "ls\r");
    expect(terminal.sendKey).toHaveBeenCalledTimes(1);
    expect(terminal.broadcastWrite).toHaveBeenCalledTimes(1);
    expect(terminal.batchDoubleEscape).toHaveBeenCalledTimes(1);
    expect(terminal.submit).toHaveBeenCalledTimes(1);
  });

  it("sends nothing while the host link is down and resumes when it is back", async () => {
    gate.setHostInputBlock({ kind: "disconnected", hostName: "studio-01" });
    typeEverything();
    await expect(terminalClient.submit("t-1", "echo hi")).rejects.toThrow(
      "Read-only until studio-01 reconnects"
    );
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.sendKey).not.toHaveBeenCalled();
    expect(terminal.broadcastWrite).not.toHaveBeenCalled();
    expect(terminal.batchDoubleEscape).not.toHaveBeenCalled();
    expect(terminal.submit).not.toHaveBeenCalled();

    gate.setHostInputBlock(null);
    terminalClient.write("t-1", "ls\r");
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });

  it("still resizes while blocked: geometry is not input", () => {
    gate.setHostInputBlock({ kind: "disconnected", hostName: "studio-01" });
    terminalClient.resize("t-1", 80, 24);
    expect(terminal.resize).toHaveBeenCalledTimes(1);
  });

  it("blocks input while another frontend drives, with its name as the reason", async () => {
    gate.setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "greg-mbp" });
    terminalClient.write("t-1", "x");
    expect(terminal.write).not.toHaveBeenCalled();
    await expect(terminalClient.submit("t-1", "x")).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
  });

  it("reports a lost link ahead of a lease and notifies only on change", () => {
    const listener = vi.fn();
    gate.subscribeTerminalInputGate(listener);
    gate.setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "greg-mbp" });
    gate.setHostInputBlock({ kind: "disconnected", hostName: "studio-01" });
    gate.setHostInputBlock({ kind: "disconnected", hostName: "studio-01" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(gate.getTerminalInputBlock()).toEqual({ kind: "disconnected", hostName: "studio-01" });
    gate.setHostInputBlock(null);
    expect(gate.getTerminalInputBlock()).toEqual({
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
    });
  });

  it("holds input while a remote view doesn't know who drives, as a retriable reason", async () => {
    gate.setLeaseInputBlock({ kind: "lease-unknown", hostName: "studio-01" });
    terminalClient.write("t-1", "x");
    expect(terminal.write).not.toHaveBeenCalled();
    await expect(terminalClient.submit("t-1", "x")).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
  });

  it("announces input opening only when the last block lifts", () => {
    const unblocked = vi.fn();
    gate.onTerminalInputUnblocked(unblocked);
    gate.setHostInputBlock(null);
    expect(unblocked).not.toHaveBeenCalled();

    gate.setLeaseInputBlock({ kind: "lease-unknown", hostName: "studio-01" });
    gate.setHostInputBlock({ kind: "disconnected", hostName: "studio-01" });
    gate.setLeaseInputBlock(null);
    expect(unblocked).not.toHaveBeenCalled();
    gate.setHostInputBlock(null);
    expect(unblocked).toHaveBeenCalledTimes(1);
  });
});
