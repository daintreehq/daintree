import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSharedBuffersMock } = vi.hoisted(() => ({
  getSharedBuffersMock: vi.fn(),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      getSharedBuffers: getSharedBuffersMock,
    },
  };
});

describe("TerminalInstanceService bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("does not auto-initialize terminal ingestion without an Electron terminal bridge", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../TerminalInstanceService");

    expect(getSharedBuffersMock).not.toHaveBeenCalled();
    expect(
      [...warnSpy.mock.calls, ...errorSpy.mock.calls].some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("[TerminalOutputIngestService]"))
      )
    ).toBe(false);
  });

  it("auto-initializes terminal ingestion when the Electron terminal bridge is available", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          terminal: {
            getSharedBuffers: vi.fn(),
          },
        },
      },
      configurable: true,
      writable: true,
    });

    getSharedBuffersMock.mockResolvedValue({
      visualBuffers: [],
      signalBuffer: null,
    });

    await import("../TerminalInstanceService");
    await Promise.resolve();
    await Promise.resolve();

    expect(getSharedBuffersMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[TerminalOutputIngestService] SharedArrayBuffer unavailable, using IPC"
      ),
      expect.anything()
    );
  });
});
