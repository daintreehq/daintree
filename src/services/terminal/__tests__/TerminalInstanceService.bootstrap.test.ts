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

  it("builds nothing at module eval, and the accessor's load() builds it once", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Each service built starts its ingest, which says so: a count of builds.
    const builds = () =>
      logSpy.mock.calls.filter((call) =>
        call.some(
          (arg) => typeof arg === "string" && arg.includes("[TerminalOutputIngestService] Using")
        )
      ).length;
    Object.defineProperty(globalThis, "window", {
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        electron: { terminal: { getSharedBuffers: vi.fn() } },
      },
      configurable: true,
      writable: true,
    });

    await import("../TerminalInstanceService");
    const accessor = await import("../terminalInstanceServiceAccessor");
    await Promise.resolve();
    await Promise.resolve();
    expect(builds()).toBe(0);
    expect(accessor.peek()).toBeNull();

    const [first, second] = await Promise.all([accessor.load(), accessor.load()]);
    const third = await accessor.load();
    await Promise.resolve();
    await Promise.resolve();

    expect(builds()).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(accessor.peek()).toBe(first);
  });

  it("does not auto-initialize terminal ingestion without an Electron terminal bridge", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    (await import("../TerminalInstanceService")).createTerminalPaintPlane();

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

    (await import("../TerminalInstanceService")).createTerminalPaintPlane();
    await Promise.resolve();
    await Promise.resolve();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[TerminalOutputIngestService] Using MessagePort data path (SAB worker disabled)"
      ),
      expect.anything()
    );
  });
});
