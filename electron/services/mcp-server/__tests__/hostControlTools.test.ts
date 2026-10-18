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
    expect(runtime.list).toHaveBeenCalledWith("hub");

    bound = undefined;
    expect(access.isCallReachable()).toBe(false);
    await expect(access.run("host.list", {})).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(runtime.list).toHaveBeenCalledTimes(1);
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

  it("refuses with no access at all", async () => {
    await expect(runHostControlTool("host.list", {}, undefined)).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
  });
});
