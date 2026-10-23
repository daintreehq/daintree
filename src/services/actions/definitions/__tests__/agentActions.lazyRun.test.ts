import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  shortcutLookups: 0,
  failImpl: false,
  launch: vi.fn(),
  shortcut: vi.fn(),
}));

// Getters, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../agentActions.impl", () => ({
  get agentActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "agent.launch": m.launch };
  },
  get launchAgentShortcut() {
    m.shortcutLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return m.shortcut;
  },
}));

vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: { claude: { name: "Claude" }, codex: { name: "Codex" } },
}));

// Only the two callbacks agent runs use; the rest stay absent.
function makeCallbacks(): ActionCallbacks {
  const cb: ActionCallbacks = Object.create(null);
  return Object.assign(cb, { onLaunchAgent: vi.fn(), onOpenQuickSwitcher: vi.fn() });
}

const callbacks = makeCallbacks();
const ctx: ActionContext = { dispatchSource: "agent" };

async function register(withCallbacks: ActionCallbacks = callbacks): Promise<ActionRegistry> {
  const { registerAgentActions } = await import("../agentActions");
  const actions: ActionRegistry = new Map();
  registerAgentActions(actions, withCallbacks);
  return actions;
}

describe("agent action run bodies (#14268)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.shortcutLookups = 0;
    m.failImpl = false;
    m.launch.mockReset().mockResolvedValue({ launched: true });
    m.shortcut.mockReset().mockResolvedValue({ terminalId: "t1", location: "grid" });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(actions.has("agent.claude")).toBe(true);
    expect(m.runLookups).toBe(0);
    expect(m.shortcutLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("agent.launch")!();
    const args = { agentId: "claude" };

    await expect(def.run(args, ctx)).resolves.toEqual({ launched: true });
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.launch).toHaveBeenCalledTimes(2);
    expect(m.launch).toHaveBeenCalledWith(args, ctx, callbacks);
  });

  it("lets the run body reach the registrar's onLaunchAgent", async () => {
    const own = makeCallbacks();
    vi.mocked(own.onLaunchAgent).mockResolvedValue(null);
    m.launch.mockImplementation((_args: unknown, _ctx: ActionContext, cb: ActionCallbacks) =>
      cb.onLaunchAgent("claude", {})
    );
    const def = (await register(own)).get("agent.launch")!();

    await expect(def.run({ agentId: "claude" }, ctx)).resolves.toBeNull();
    expect(own.onLaunchAgent).toHaveBeenCalledWith("claude", {});
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
  });

  it("keeps each registry's callbacks apart", async () => {
    const first = makeCallbacks();
    const second = makeCallbacks();
    const { registerAgentActions } = await import("../agentActions");
    const a: ActionRegistry = new Map();
    const b: ActionRegistry = new Map();
    registerAgentActions(a, first);
    registerAgentActions(b, second);

    await a.get("agent.launch")!().run({ agentId: "claude" }, ctx);
    await b.get("agent.launch")!().run({ agentId: "claude" }, ctx);

    expect(m.launch.mock.calls[0]?.[2]).toBe(first);
    expect(m.launch.mock.calls[1]?.[2]).toBe(second);
  });

  it("hands each per-agent shortcut its own agent id and the registrar's callbacks", async () => {
    const actions = await register();
    const args = { location: "dock" };

    await expect(actions.get("agent.claude")!().run(args, ctx)).resolves.toEqual({
      terminalId: "t1",
      location: "grid",
    });
    await actions.get("agent.codex")!().run(args, ctx);

    expect(m.shortcutLookups).toBe(2);
    expect(m.shortcut).toHaveBeenNthCalledWith(1, "claude", args, callbacks);
    expect(m.shortcut).toHaveBeenNthCalledWith(2, "codex", args, callbacks);
    expect(m.shortcut.mock.calls[0]?.[2]).toBe(callbacks);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const actions = await register();
    await expect(actions.get("agent.launch")!().run({ agentId: "claude" }, ctx)).rejects.toThrow(
      "chunk load failed"
    );
    await expect(actions.get("agent.claude")!().run({}, ctx)).rejects.toThrow("chunk load failed");
    expect(m.launch).not.toHaveBeenCalled();
    expect(m.shortcut).not.toHaveBeenCalled();
  });
});
