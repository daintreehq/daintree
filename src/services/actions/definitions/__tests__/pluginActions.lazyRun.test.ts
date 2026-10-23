import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  remoteBound: false,
  openSettings: vi.fn(),
  runs: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../pluginActions.impl", () => ({
  get pluginActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { ...m.runs, "plugin.openSettings": m.openSettings };
  },
}));

vi.mock("@/clients/operationsClient", () => ({ isRemoteBoundView: () => m.remoteBound }));

// Only the callback plugin runs use; the rest stay absent.
function makeCallbacks(): ActionCallbacks {
  const cb: ActionCallbacks = Object.create(null);
  return Object.assign(cb, { onOpenSettingsTab: vi.fn() });
}

const callbacks = makeCallbacks();
const ctx: ActionContext = { dispatchSource: "user" };
const args = { pluginId: "acme.dashboard" };

async function register(withCallbacks: ActionCallbacks = callbacks): Promise<ActionRegistry> {
  const { registerPluginActions } = await import("../pluginActions");
  const actions: ActionRegistry = new Map();
  registerPluginActions(actions, withCallbacks);
  return actions;
}

describe("plugin action run bodies (#14275)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.remoteBound = false;
    m.openSettings.mockReset().mockResolvedValue({ pluginId: "acme.dashboard" });
    m.runs = {};
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("answers isEnabled and disabledReason without loading the run bodies", async () => {
    m.remoteBound = true;
    const def = (await register()).get("plugin.backupDatabases")!();

    expect(def.isEnabled?.(ctx)).toBe(false);
    expect(def.disabledReason?.(ctx)).toBeTruthy();
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("plugin.openSettings")!();
    const result = { pluginId: "acme.dashboard" };
    m.openSettings.mockResolvedValue(result);

    await expect(def.run(args, ctx)).resolves.toBe(result);
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.openSettings).toHaveBeenCalledTimes(2);
    expect(m.openSettings.mock.calls[0]?.[0]).toBe(args);
    expect(m.openSettings.mock.calls[0]?.[1]).toBe(ctx);
    expect(m.openSettings.mock.calls[0]?.[2]).toBe(callbacks);
  });

  it("lets the run body reach the registrar's onOpenSettingsTab", async () => {
    const own = makeCallbacks();
    m.openSettings.mockImplementation((_args: unknown, _ctx: ActionContext, cb: ActionCallbacks) =>
      cb.onOpenSettingsTab({ tab: "project:plugins" })
    );
    const def = (await register(own)).get("plugin.openSettings")!();

    await def.run(args, ctx);
    expect(own.onOpenSettingsTab).toHaveBeenCalledWith({ tab: "project:plugins" });
    expect(callbacks.onOpenSettingsTab).not.toHaveBeenCalled();
  });

  it("hands every definition's dispatch to its own run body", async () => {
    const actions = await register();
    for (const id of actions.keys()) {
      m.runs[id] = vi.fn().mockResolvedValue({ ran: id });
    }
    m.openSettings.mockResolvedValue({ ran: "plugin.openSettings" });

    for (const [id, create] of actions) {
      await expect(create().run(args, ctx)).resolves.toEqual({ ran: id });
    }
    for (const [id, run] of Object.entries(m.runs)) {
      if (id === "plugin.openSettings") continue;
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(args, ctx, callbacks);
    }
  });

  it("keeps each registry's callbacks apart", async () => {
    const first = makeCallbacks();
    const second = makeCallbacks();
    const { registerPluginActions } = await import("../pluginActions");
    const a: ActionRegistry = new Map();
    const b: ActionRegistry = new Map();
    registerPluginActions(a, first);
    registerPluginActions(b, second);

    await a.get("plugin.openSettings")!().run(args, ctx);
    await b.get("plugin.openSettings")!().run(args, ctx);

    expect(m.openSettings.mock.calls[0]?.[2]).toBe(first);
    expect(m.openSettings.mock.calls[1]?.[2]).toBe(second);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("plugin.openSettings")!();
    await expect(def.run(args, ctx)).rejects.toThrow("chunk load failed");
    expect(m.openSettings).not.toHaveBeenCalled();
  });
});
