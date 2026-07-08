// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

// A manually-resolvable gate for setupTerminalAddons so a test can wedge a
// destroy() into the exact mid-build window (between the addon await and the
// onData wiring). Default null → the standard mock below resolves immediately.
let addonGate: { promise: Promise<void>; resolve: () => void } | null = null;
function armAddonGate(): () => void {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  addonGate = { promise, resolve };
  return () => {
    addonGate = null;
    resolve();
  };
}

// onData is the crux: the assistant double-render was two onData(id, …)
// subscriptions on ONE id (the overlay's prewarmTerminal racing the XtermAdapter
// mount, both calling getOrCreate across the async setupTerminalAddons gap). This
// hoisted spy counts registrations per id.
const { onDataMock } = vi.hoisted(() => ({
  onDataMock: vi.fn((_id: string, _cb: (data: string | Uint8Array) => void) => vi.fn()),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: onDataMock,
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

// Mocked but STILL awaited by getOrCreate — the `await` on a resolved value
// suspends to a microtask, which is exactly the window two concurrent creates
// interleave across. (Async in prod because #10840 lazy-loads Unicode11.)
vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(async () => {
    if (addonGate) await addonGate.promise; // hold the build open for a test
    return {
      fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })) },
      serializeAddon: { serialize: vi.fn() },
      imageAddon: { dispose: vi.fn() },
      searchAddon: {},
      fileLinksDisposable: { dispose: vi.fn() },
      webLinksAddon: { dispose: vi.fn() },
    };
  }),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

type CreateTestService = {
  instances: Map<string, unknown>;
  creating: Map<string, unknown>;
  getOrCreate: (
    id: string,
    launchAgentId: string | undefined,
    options: unknown,
    getRefreshTier?: () => TerminalRefreshTier
  ) => Promise<{ id: string }>;
  destroy: (id: string) => void;
};

describe("TerminalInstanceService.getOrCreate concurrent-create guard (assistant double-render)", () => {
  let service: CreateTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // jsdom lacks these element APIs the post-create tier/policy pass touches;
    // the concurrency guard under test runs entirely before they matter.
    if (!("checkVisibility" in HTMLElement.prototype)) {
      (HTMLElement.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility =
        () => true;
    }
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: CreateTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    addonGate = null;
  });

  function onDataCountFor(id: string): number {
    return onDataMock.mock.calls.filter((call) => call[0] === id).length;
  }

  it("wires exactly ONE onData subscription when two getOrCreate(id) race (prewarm vs mount)", async () => {
    const id = "asst-1";

    // Both calls start synchronously (Promise.all), so both reach the awaited
    // setupTerminalAddons before either registers its instance — the exact
    // prewarmTerminal-vs-XtermAdapter race on "+"/new-session.
    const [a, b] = await Promise.all([
      service.getOrCreate(id, "daintree-assistant", { fontSize: 13 }),
      service.getOrCreate(id, "daintree-assistant", { fontSize: 13 }),
    ]);

    expect(a).toBe(b); // one shared instance, not two
    expect(onDataCountFor(id)).toBe(1); // ← was 2 before the guard: double delivery
    expect(service.instances.get(id)).toBe(a);
  });

  it("returns the same instance and adds no new subscription on a later getOrCreate(id)", async () => {
    const id = "asst-2";
    const first = await service.getOrCreate(id, "daintree-assistant", { fontSize: 13 });
    const second = await service.getOrCreate(id, "daintree-assistant", { fontSize: 13 });

    expect(second).toBe(first);
    expect(onDataCountFor(id)).toBe(1);
  });

  it("frees the in-flight slot so a fresh id after teardown still creates exactly one", async () => {
    const id = "asst-3";
    const [a] = await Promise.all([
      service.getOrCreate(id, "daintree-assistant", { fontSize: 13 }),
      service.getOrCreate(id, "daintree-assistant", { fontSize: 13 }),
    ]);
    expect(onDataCountFor(id)).toBe(1);
    service.destroy(id);

    // A subsequent distinct id (a new "+"/session) creates cleanly — the guard
    // map didn't strand the prior id.
    const other = await service.getOrCreate("asst-4", "daintree-assistant", { fontSize: 13 });
    expect(a).not.toBe(other);
    expect(onDataCountFor("asst-4")).toBe(1);
  });

  it("aborts a build whose id is destroyed mid-flight — no stale instance or onData survives", async () => {
    const id = "asst-5";
    const release = armAddonGate(); // hold setupTerminalAddons open

    const createP = service.getOrCreate(id, "daintree-assistant", { fontSize: 13 });
    await Promise.resolve(); // let getOrCreate run up to the addon await

    // The panel is torn down while the build is suspended (e.g. "+"/replaceExisting
    // removing the just-reserved terminal before its addons finished loading).
    service.destroy(id);
    release(); // addons resolve → the build must consume the cancel and abort

    await expect(createP).rejects.toThrow(/cancelled/);
    expect(service.instances.get(id)).toBeUndefined();
    expect(onDataCountFor(id)).toBe(0); // never wired a listener for the dead id
    expect(service.creating.has(id)).toBe(false); // slot freed

    // The id is reusable afterward (no stranded cancel/creating state).
    const fresh = await service.getOrCreate(id, "daintree-assistant", { fontSize: 13 });
    expect(service.instances.get(id)).toBe(fresh);
    expect(onDataCountFor(id)).toBe(1);
  });
});
