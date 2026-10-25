import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindHostControl,
  runHostControlTool,
  setHostControlRuntime,
  type HostControlRuntimeHandle,
} from "../hostControlTools.js";

function fakeRuntime() {
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  return {
    isCallReachable: vi.fn((helpSessionId: string) => helpSessionId === "hub"),
    list: vi.fn(() => ok({ hosts: [] })),
    call: vi.fn(() =>
      ok({ outcome: "ok" as const, detail: null, retryAfterMs: null, callId: "c", result: null })
    ),
    ensureProject: vi.fn(() =>
      ok({ outcome: "ok" as const, detail: null, retryAfterMs: null, hostId: "h", answer: null })
    ),
    settings: vi.fn(() =>
      ok({ outcome: "ok" as const, detail: null, retryAfterMs: null, ticket: null, hosts: [] })
    ),
    watch: vi.fn(() =>
      ok({
        outcome: "ok" as const,
        detail: null,
        retryAfterMs: null,
        armed: false,
        watches: [],
        observed: null,
      })
    ),
  } satisfies HostControlRuntimeHandle;
}

describe("bindHostControl (#13493)", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("answers for whichever help session the transport is bound to at each call", async () => {
    const runtime = fakeRuntime();
    uninstall = setHostControlRuntime(runtime);
    let bound: string | undefined = "hub";
    const access = bindHostControl(() => bound);

    expect(access.isCallReachable()).toBe(true);
    await access.run("host.list", {});
    expect(runtime.list).toHaveBeenCalledWith("hub", {});
    await access.run("host.list", { includeAgents: true, projectId: "p1" });
    expect(runtime.list).toHaveBeenLastCalledWith("hub", { includeAgents: true, projectId: "p1" });
    expect(await access.run("host.list", { includeAgents: "yes" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });

    bound = undefined;
    expect(access.isCallReachable()).toBe(false);
    await expect(access.run("host.list", {})).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(runtime.list).toHaveBeenCalledTimes(2);
  });

  it("offers nothing once the runtime is gone, and keeps a newer one on a late teardown", async () => {
    const older = setHostControlRuntime(fakeRuntime());
    const access = bindHostControl(() => "hub");
    older();
    expect(access.isCallReachable()).toBe(false);
    await expect(access.run("host.list", {})).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });

    const again = setHostControlRuntime(fakeRuntime());
    uninstall = setHostControlRuntime(fakeRuntime());
    again();
    expect(access.isCallReachable()).toBe(true);
  });
});

describe("runHostControlTool (#13493)", () => {
  it("refuses arguments outside the schema, and any retired host tool, in fixed words", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const results = await Promise.all([
      runHostControlTool("host.call", { hostId: "h" }, access, { tier: "core" }),
      runHostControlTool(
        "host.sendMessage",
        { hostId: "h", projectId: "p", slot: 0, generation: "g", text: "hi" },
        access
      ),
    ]);
    uninstall();
    for (const result of results) {
      expect(result).toEqual({
        ok: false,
        code: "INVALID_ARGS",
        message: "The arguments don't match this tool's schema.",
      });
    }
    expect(runtime.call).not.toHaveBeenCalled();
  });

  it("hands host.call to the runtime with the calling session's tier, and never without one", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const args = { hostId: "h", projectId: "p", tool: "terminal.list", args: { owned: true } };

    await runHostControlTool("host.call", args, access, { tier: "full" });
    const untiered = await runHostControlTool("host.call", args, access);
    const missing = await runHostControlTool(
      "host.call",
      { hostId: "h", tool: "terminal.list" },
      access,
      { tier: "core" }
    );
    uninstall();
    expect(runtime.call).toHaveBeenCalledTimes(1);
    expect(runtime.call).toHaveBeenCalledWith("hub", args, { tier: "full" });
    expect(untiered).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(missing).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.call exactly one target, and refuses both or neither at the boundary (#14444)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const launch = { tool: "throwaway.launch", args: { agentId: "claude" } };
    const send = (args: Record<string, unknown>) =>
      runHostControlTool("host.call", { hostId: "h", ...args }, access, { tier: "core" });

    const throwaway = await send({ throwaway: true, ...launch });
    const project = await send({ projectId: "p", tool: "terminal.list" });
    const refused = await Promise.all([
      send({ projectId: "p", throwaway: true, ...launch }),
      send(launch),
      send({ throwaway: false, ...launch }),
      // A throwaway target takes only its own tools, with only their own arguments.
      send({ throwaway: true, tool: "terminal.list" }),
      send({ throwaway: true, tool: "throwaway.launch", args: { agentId: "claude", cwd: "/" } }),
      send({ throwaway: true, tool: "throwaway.close" }),
    ]);
    uninstall();
    expect(throwaway).toMatchObject({ ok: true });
    expect(project).toMatchObject({ ok: true });
    expect(runtime.call).toHaveBeenCalledTimes(2);
    expect(runtime.call).toHaveBeenNthCalledWith(
      1,
      "hub",
      { hostId: "h", throwaway: true, ...launch },
      { tier: "core" }
    );
    for (const result of refused) expect(result).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    // A throwaway call that doesn't parse names the tools it takes (#14446); others don't.
    const [, neither, notTrue, projectTool] = refused;
    expect(projectTool).toMatchObject({
      message: expect.stringContaining("throwaway.close {runId}"),
    });
    expect(neither).not.toMatchObject({ message: expect.stringContaining("throwaway") });
    expect(notTrue).not.toMatchObject({ message: expect.stringContaining("throwaway") });
  });

  it("hands host.call the caller's own first-send id, and refuses one sent beside a callId (#14240)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const args = { hostId: "h", projectId: "p", tool: "terminal.list", newCallId: "mine-1" };

    await runHostControlTool("host.call", args, access, { tier: "core" });
    const both = await runHostControlTool("host.call", { ...args, callId: "mine-1" }, access, {
      tier: "core",
    });
    const empty = await runHostControlTool("host.call", { ...args, newCallId: "" }, access, {
      tier: "core",
    });
    uninstall();
    expect(runtime.call).toHaveBeenCalledTimes(1);
    expect(runtime.call).toHaveBeenCalledWith("hub", args, { tier: "core" });
    expect(both).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(empty).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.ensureProject its parsed arguments, and refuses ones that don't parse", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const args = { hostId: "h", worktree: true, accept: ["unpushed"] };

    await runHostControlTool("host.ensureProject", args, access);
    const bad = await runHostControlTool(
      "host.ensureProject",
      { hostId: "h", accept: ["push"] },
      access
    );
    uninstall();
    expect(runtime.ensureProject).toHaveBeenCalledTimes(1);
    expect(runtime.ensureProject).toHaveBeenCalledWith("hub", args);
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.settings only the arguments its operation takes (#14167)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const preview = { operation: "preview", hostIds: ["h"], patch: { canopyMode: "on" } };

    await runHostControlTool("host.settings", preview, access);
    await runHostControlTool("host.settings", { operation: "apply", ticket: "t" }, access);
    const refused = await Promise.all(
      [
        // An apply carries its ticket and nothing it could swap in for what was approved.
        { operation: "apply", ticket: "t", patch: { canopyMode: "on" } },
        { operation: "apply", ticket: "t", hostIds: ["other"] },
        { operation: "apply" },
        { operation: "preview", hostIds: ["h"], patch: {} },
        { operation: "preview", hostIds: ["h"], patch: { appTheme: "x" } },
        { operation: "read", hostIds: ["h"], ticket: "t" },
        { operation: "read" },
        { operation: "read", hostIds: ["h"], keys: [] },
      ].map((args) => runHostControlTool("host.settings", args, access))
    );
    uninstall();
    expect(runtime.settings).toHaveBeenCalledTimes(2);
    expect(runtime.settings).toHaveBeenCalledWith("hub", preview);
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("hands host.watch one kind of condition to arm, and each operation only its own arguments (#14463)", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostControlRuntime(runtime);
    const access = bindHostControl(() => "hub");
    const accepted = [
      { operation: "arm", hostId: "h", connection: "connected", note: "go", expiresInSeconds: 600 },
      { operation: "arm", hostId: "h", memoryAvailableBytesAtLeast: 1, memoryPressureAtMost: "warn" },
      { operation: "cancel", watchId: "hw-1" },
      { operation: "list" },
      { operation: "list", hostId: "h" },
    ];
    for (const args of accepted) await runHostControlTool("host.watch", args, access);
    const refused = await Promise.all(
      [
        { operation: "arm", connection: "connected" },
        { operation: "arm", hostId: "h" },
        // A link watch and a capacity watch are two watches.
        { operation: "arm", hostId: "h", connection: "connected", cpuIdleCoresAtLeast: 2 },
        { operation: "arm", hostId: "h", connection: "connected", watchId: "hw-1" },
        { operation: "arm", hostId: "h", connection: "connected", expiresInSeconds: 30 },
        { operation: "arm", hostId: "h", memoryAvailableBytesAtLeast: -1 },
        { operation: "cancel" },
        { operation: "cancel", watchId: "hw-1", hostId: "h" },
        { operation: "cancel", watchId: "hw-1", connection: "connected" },
        { operation: "list", watchId: "hw-1" },
        { operation: "list", note: "x" },
      ].map((args) => runHostControlTool("host.watch", args, access))
    );
    uninstall();
    expect(runtime.watch).toHaveBeenCalledTimes(accepted.length);
    expect(runtime.watch).toHaveBeenCalledWith("hub", accepted[0]);
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("refuses with no access at all", async () => {
    await expect(runHostControlTool("host.list", {}, undefined)).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
  });
});
