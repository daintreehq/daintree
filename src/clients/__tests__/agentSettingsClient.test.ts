import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let agentSettingsClient: typeof import("../agentSettingsClient").agentSettingsClient;

let getMock: ReturnType<typeof vi.fn>;
let setMock: ReturnType<typeof vi.fn>;
let setGlobalMock: ReturnType<typeof vi.fn>;
let setGlobalInlineMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let stampVersionMock: ReturnType<typeof vi.fn>;

describe("agentSettingsClient", () => {
  beforeEach(async () => {
    vi.resetModules();

    getMock = vi.fn();
    setMock = vi.fn().mockResolvedValue({});
    setGlobalMock = vi.fn().mockResolvedValue({});
    setGlobalInlineMock = vi.fn().mockResolvedValue({});
    resetMock = vi.fn().mockResolvedValue({});
    stampVersionMock = vi.fn().mockResolvedValue({});

    typedGlobal.window = {
      electron: {
        agentSettings: {
          get: getMock,
          set: setMock,
          setGlobal: setGlobalMock,
          setGlobalInline: setGlobalInlineMock,
          reset: resetMock,
          stampVersion: stampVersionMock,
        },
      },
    };

    const mod = await import("../agentSettingsClient");
    agentSettingsClient = mod.agentSettingsClient;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("coalesces concurrent get() calls into a single IPC call", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getMock.mockReturnValue(deferred);

    const p1 = agentSettingsClient.get();
    const p2 = agentSettingsClient.get();

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);

    resolve({ claude: { pinned: true } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ claude: { pinned: true } });
    expect(r2).toEqual({ claude: { pinned: true } });
  });

  it("caches the resolved value — sequential get() calls skip the IPC", async () => {
    getMock.mockResolvedValue({ claude: {} });

    const first = await agentSettingsClient.get();
    const second = await agentSettingsClient.get();

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("invalidate() drops the cache so the next get() hits main", async () => {
    getMock.mockResolvedValueOnce({ claude: {} });
    await agentSettingsClient.get();

    agentSettingsClient.invalidate();

    getMock.mockResolvedValueOnce({ claude: { pinned: true } });
    const fresh = await agentSettingsClient.get();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({ claude: { pinned: true } });
  });

  it("does not cache a snapshot fetched across a write window", async () => {
    let resolve!: (v: unknown) => void;
    getMock.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );

    const racing = agentSettingsClient.get();
    await agentSettingsClient.set("claude", { pinned: true });
    resolve({ claude: {} });
    await racing;

    getMock.mockResolvedValueOnce({ claude: { pinned: true } });
    const fresh = await agentSettingsClient.get();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({ claude: { pinned: true } });
  });

  it("recovers from a rejected get() on the next call", async () => {
    getMock.mockRejectedValueOnce(new Error("IPC error"));

    await expect(agentSettingsClient.get()).rejects.toThrow("IPC error");

    getMock.mockResolvedValue({ claude: {} });
    const result = await agentSettingsClient.get();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ claude: {} });
  });

  it("set() clears the inflight get() so post-write reads start fresh", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getMock.mockReturnValueOnce(deferred);

    const stale = agentSettingsClient.get();
    void agentSettingsClient.set("claude", { pinned: true });

    getMock.mockResolvedValue({ claude: { pinned: true } });
    const fresh = agentSettingsClient.get();
    expect(fresh).not.toBe(stale);
    expect(getMock).toHaveBeenCalledTimes(2);

    resolve({ claude: {} });
    await expect(fresh).resolves.toEqual({ claude: { pinned: true } });
  });

  it("setGlobal() forwards the value and clears the inflight get() so post-write reads start fresh (#10432)", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getMock.mockReturnValueOnce(deferred);

    const stale = agentSettingsClient.get();
    void agentSettingsClient.setGlobal(true);
    expect(setGlobalMock).toHaveBeenCalledWith(true);

    getMock.mockResolvedValue({ globalSkipPermissions: true });
    const fresh = agentSettingsClient.get();
    expect(fresh).not.toBe(stale);
    expect(getMock).toHaveBeenCalledTimes(2);

    resolve({});
    await expect(fresh).resolves.toEqual({ globalSkipPermissions: true });
  });

  it("setGlobalInline() forwards the value and clears the inflight get() (#10876)", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getMock.mockReturnValueOnce(deferred);

    const stale = agentSettingsClient.get();
    void agentSettingsClient.setGlobalInline(true);
    expect(setGlobalInlineMock).toHaveBeenCalledWith(true);

    getMock.mockResolvedValue({ globalUseAltScreen: true });
    const fresh = agentSettingsClient.get();
    expect(fresh).not.toBe(stale);
    expect(getMock).toHaveBeenCalledTimes(2);

    resolve({});
    await expect(fresh).resolves.toEqual({ globalUseAltScreen: true });
  });

  it("reset() and stampVersion() also clear the inflight get()", async () => {
    let resolveFirst!: (v: unknown) => void;
    getMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r;
      })
    );
    const stale = agentSettingsClient.get();
    void agentSettingsClient.reset();
    getMock.mockResolvedValueOnce({});
    const fresh = agentSettingsClient.get();
    expect(fresh).not.toBe(stale);
    resolveFirst({});
    await Promise.all([stale, fresh]);

    let resolveSecond!: (v: unknown) => void;
    getMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveSecond = r;
      })
    );
    const stale2 = agentSettingsClient.get();
    void agentSettingsClient.stampVersion(2);
    getMock.mockResolvedValueOnce({});
    const fresh2 = agentSettingsClient.get();
    expect(fresh2).not.toBe(stale2);
    expect(getMock).toHaveBeenCalledTimes(4);
    resolveSecond({});
    await Promise.all([stale2, fresh2]);
  });
});
