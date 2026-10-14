import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindAssistantMessaging,
  runAssistantMessagingTool,
  setAssistantMessagingRuntime,
  type AssistantMessagingRuntimeHandle,
} from "../assistantMessagingTools.js";

function fakeRuntime(): AssistantMessagingRuntimeHandle & {
  getInbox: ReturnType<typeof vi.fn>;
} {
  return {
    isAvailable: vi.fn((helpSessionId: string) => helpSessionId === "help-1"),
    getInbox: vi.fn(() => ({
      ok: true as const,
      value: { messages: [], cursor: 0, hasMore: false },
    })),
    reply: vi.fn(() => ({
      ok: true as const,
      value: { taskId: "t", state: "completed" as const, revision: 1 },
    })),
  };
}

describe("bindAssistantMessaging (#13335)", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("answers for whichever help session the transport is bound to at each call", () => {
    const runtime = fakeRuntime();
    uninstall = setAssistantMessagingRuntime(runtime);
    let bound: string | undefined = "help-1";
    const access = bindAssistantMessaging(() => bound);

    expect(access.isAvailable()).toBe(true);
    access.getInbox({});
    expect(runtime.getInbox).toHaveBeenCalledWith("help-1", {});

    bound = undefined;
    expect(access.isAvailable()).toBe(false);
    expect(access.getInbox({})).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(runtime.getInbox).toHaveBeenCalledTimes(1);
  });

  it("offers nothing once the runtime is gone", () => {
    const access = bindAssistantMessaging(() => "help-1");
    uninstall = setAssistantMessagingRuntime(fakeRuntime());
    expect(access.isAvailable()).toBe(true);
    uninstall();
    uninstall = null;
    expect(access.isAvailable()).toBe(false);
    expect(access.reply({ taskId: "t", state: "completed", text: "x" })).toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
  });

  it("leaves a newer runtime installed when an older one's teardown runs late", () => {
    const older = setAssistantMessagingRuntime(fakeRuntime());
    uninstall = setAssistantMessagingRuntime(fakeRuntime());
    older();
    expect(bindAssistantMessaging(() => "help-1").isAvailable()).toBe(true);
  });
});

describe("runAssistantMessagingTool (#13335)", () => {
  it("refuses arguments outside the schema in fixed words", () => {
    const runtime = fakeRuntime();
    const uninstall = setAssistantMessagingRuntime(runtime);
    const access = bindAssistantMessaging(() => "help-1");
    const result = runAssistantMessagingTool("assistant.getInbox", { limit: 99 }, access);
    uninstall();
    expect(result).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(runtime.getInbox).not.toHaveBeenCalled();
  });

  it("refuses with no access at all", () => {
    expect(runAssistantMessagingTool("assistant.reply", {}, undefined)).toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
  });
});
