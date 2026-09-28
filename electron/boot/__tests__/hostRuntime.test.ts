import { describe, expect, it, vi } from "vitest";
import { createHostRuntime, type HostRuntimeSteps } from "../hostRuntime.js";

function makeSteps(overrides?: Partial<HostRuntimeSteps>) {
  const order: string[] = [];
  const record = (name: string) => async (): Promise<void> => {
    order.push(name);
  };
  const steps: HostRuntimeSteps = {
    initGlobalServices: vi.fn(async () => {
      order.push("global");
      return "ok" as const;
    }),
    prepareServices: vi.fn(() => {
      order.push("prepare");
    }),
    startPtyHost: vi.fn(record("pty-host")),
    startWorkspaceHostPool: vi.fn(record("workspace-hosts")),
    startMcp: vi.fn(record("mcp")),
    startPluginHost: vi.fn(record("plugin-host")),
    startPowerPolicy: vi.fn(() => {
      order.push("power");
    }),
    releaseDeferredTasks: vi.fn(() => {
      order.push("deferred");
    }),
    ...overrides,
  };
  return { steps, order };
}

describe("createHostRuntime", () => {
  it("starts every service with no window, in dependency order", async () => {
    const { steps, order } = makeSteps();
    const runtime = createHostRuntime(steps);

    expect(await runtime.start()).toBe("ok");

    expect(order).toEqual([
      "global",
      "prepare",
      "pty-host",
      "workspace-hosts",
      "mcp",
      "plugin-host",
      "power",
      "deferred",
    ]);
    expect(runtime.isStarted()).toBe(true);
  });

  it("waits for each step before starting the next", async () => {
    let releasePty!: () => void;
    const { steps, order } = makeSteps({
      startPtyHost: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePty = resolve;
          })
      ),
    });
    const runtime = createHostRuntime(steps);

    const started = runtime.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["global", "prepare"]);
    expect(runtime.isStarted()).toBe(false);

    releasePty();
    await started;
    expect(order.slice(2)).toEqual(["workspace-hosts", "mcp", "plugin-host", "power", "deferred"]);
  });

  it("runs once however many times it is asked", async () => {
    const { steps } = makeSteps();
    const runtime = createHostRuntime(steps);

    const [a, b] = await Promise.all([runtime.start(), runtime.start()]);
    await runtime.start();

    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(steps.initGlobalServices).toHaveBeenCalledTimes(1);
    expect(steps.startPtyHost).toHaveBeenCalledTimes(1);
    expect(steps.startWorkspaceHostPool).toHaveBeenCalledTimes(1);
  });

  it("stops before forking anything when global init asks the process to exit", async () => {
    const { steps, order } = makeSteps({
      initGlobalServices: vi.fn(async () => "exit-requested" as const),
    });
    const runtime = createHostRuntime(steps);

    expect(await runtime.start()).toBe("exit-requested");
    expect(order).toEqual([]);
    expect(steps.prepareServices).not.toHaveBeenCalled();
    expect(runtime.isStarted()).toBe(false);
  });

  it("lets a later request retry after a step throws", async () => {
    const startMcp = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("bind failed"))
      .mockResolvedValue(undefined);
    const { steps } = makeSteps({ startMcp });
    const runtime = createHostRuntime(steps);

    await expect(runtime.start()).rejects.toThrow("bind failed");
    expect(runtime.isStarted()).toBe(false);

    expect(await runtime.start()).toBe("ok");
    expect(startMcp).toHaveBeenCalledTimes(2);
  });
});
