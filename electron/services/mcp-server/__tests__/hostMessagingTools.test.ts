import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindHostMessaging,
  runHostMessagingTool,
  setHostMessagingRuntime,
  type HostMessagingRuntimeHandle,
} from "../hostMessagingTools.js";

function fakeRuntime() {
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  return {
    isAvailable: vi.fn((helpSessionId: string) => helpSessionId === "hub"),
    list: vi.fn(() => ok({ hosts: [] })),
    listAssistants: vi.fn(),
    sendMessage: vi.fn(),
    getTask: vi.fn(() =>
      ok({
        outcome: "not_found" as const,
        detail: "none",
        retryAfterMs: null,
        hostId: "h",
        taskId: "t",
        task: null,
        observedAt: null,
        replies: null,
        repliesOmitted: 0,
      })
    ),
    listTasks: vi.fn(),
    cancelTask: vi.fn(),
    startAssistant: vi.fn(),
  } satisfies HostMessagingRuntimeHandle;
}

describe("bindHostMessaging (#13336)", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("answers for whichever help session the transport is bound to at each call", async () => {
    const runtime = fakeRuntime();
    uninstall = setHostMessagingRuntime(runtime);
    let bound: string | undefined = "hub";
    const access = bindHostMessaging(() => bound);

    expect(access.isAvailable()).toBe(true);
    await access.run("host.getTask", { hostId: "h", taskId: "t" });
    expect(runtime.getTask).toHaveBeenCalledWith("hub", { hostId: "h", taskId: "t" });

    bound = undefined;
    expect(access.isAvailable()).toBe(false);
    await expect(access.run("host.list", {})).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(runtime.list).not.toHaveBeenCalled();
  });

  it("offers nothing once the runtime is gone, and keeps a newer one on a late teardown", async () => {
    const older = setHostMessagingRuntime(fakeRuntime());
    const access = bindHostMessaging(() => "hub");
    older();
    expect(access.isAvailable()).toBe(false);
    await expect(access.run("host.list", {})).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });

    const again = setHostMessagingRuntime(fakeRuntime());
    uninstall = setHostMessagingRuntime(fakeRuntime());
    again();
    expect(access.isAvailable()).toBe(true);
  });
});

describe("runHostMessagingTool (#13336)", () => {
  it("refuses arguments outside the schema in fixed words, never echoing them", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostMessagingRuntime(runtime);
    const access = bindHostMessaging(() => "hub");
    const result = await runHostMessagingTool(
      "host.sendMessage",
      { hostId: "h", projectId: "p", slot: 0, generation: "g", text: "", waitMs: 99_999 },
      access
    );
    uninstall();
    expect(result).toEqual({
      ok: false,
      code: "INVALID_ARGS",
      message: "The arguments don't match this tool's schema.",
    });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("hands a start to the runtime only with a projectId, and an agent and startNew when given", async () => {
    const runtime = fakeRuntime();
    const uninstall = setHostMessagingRuntime(runtime);
    const access = bindHostMessaging(() => "hub");
    await runHostMessagingTool(
      "host.startAssistant",
      { hostId: "h", projectId: "p", agentId: "codex", startNew: true },
      access
    );
    const missing = await runHostMessagingTool("host.startAssistant", { hostId: "h" }, access);
    uninstall();
    expect(runtime.startAssistant).toHaveBeenCalledTimes(1);
    expect(runtime.startAssistant).toHaveBeenCalledWith("hub", {
      hostId: "h",
      projectId: "p",
      agentId: "codex",
      startNew: true,
    });
    expect(missing).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("refuses with no access at all", async () => {
    await expect(runHostMessagingTool("host.list", {}, undefined)).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
  });
});
