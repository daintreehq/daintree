import { describe, expect, it } from "vitest";
import {
  PLUGIN_TASK_DETAIL_MAX,
  PLUGIN_TASK_MESSAGE_MAX,
  PLUGIN_TASK_RETRY_ARGS_MAX_BYTES,
  PLUGIN_TASK_TITLE_MAX,
} from "../../types/plugin.js";
import {
  inertPluginTaskHandle,
  isInertPluginTaskHandle,
  mergePluginTaskProgress,
  pluginTaskAbortCause,
  pluginTaskAbortReason,
  validatePluginTaskProgress,
  validatePluginTaskResult,
  validatePluginTaskStart,
} from "../pluginTasks.js";

const retry = { actionId: "acme.import" };

describe("validatePluginTaskStart", () => {
  it("fills the defaults and trims the text", () => {
    const result = validatePluginTaskStart({ title: "  Importing records ", retry });
    expect(result).toEqual({
      ok: true,
      value: { title: "Importing records", cancellable: false, fraction: null, retry },
    });
  });

  it("keeps what was passed, and drops an empty detail", () => {
    expect(
      validatePluginTaskStart({
        title: "Sync",
        detail: "   ",
        cancellable: true,
        fraction: 0.25,
        retry: { actionId: "acme.sync", args: { full: true } },
      })
    ).toEqual({
      ok: true,
      value: {
        title: "Sync",
        cancellable: true,
        fraction: 0.25,
        retry: { actionId: "acme.sync", args: { full: true } },
      },
    });
  });

  it("copies retry args, so a later change to the plugin's object is not what Retry runs", () => {
    const args = { ids: [1, 2] };
    const result = validatePluginTaskStart({ title: "Sync", retry: { actionId: "a.b", args } });
    args.ids.push(3);
    expect(result.ok && result.value.retry.args).toEqual({ ids: [1, 2] });
  });

  it.each([
    [null, /must be an object/],
    [{ retry }, /title must be a string/],
    [{ title: " ", retry }, /title must not be empty/],
    [{ title: "a\nb", retry }, /single line/],
    [{ title: "x".repeat(PLUGIN_TASK_TITLE_MAX + 1), retry }, /at most/],
    [
      { title: "T", detail: "x".repeat(PLUGIN_TASK_DETAIL_MAX + 1), retry },
      /detail must be at most/,
    ],
    [{ title: "T", cancellable: "yes", retry }, /cancellable must be a boolean/],
    [{ title: "T", fraction: 1.5, retry }, /fraction must be a number from 0 to 1/],
    [{ title: "T", fraction: Number.NaN, retry }, /fraction must be a number from 0 to 1/],
    [{ title: "T" }, /retry must be one of this plugin's own actions/],
    [{ title: "T", retry: { actionId: "" } }, /retry.actionId must be a non-empty string/],
    [{ title: "T", retry: { actionId: "a.b", label: "x" } }, /unsupported field "label"/],
    [{ title: "T", retry, extra: 1 }, /unsupported field "extra"/],
    [{ title: "T", retry: { actionId: "a.b", args: [1] } }, /retry.args must be an object/],
  ])("refuses %j", (options, error) => {
    const result = validatePluginTaskStart(options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  });

  it("refuses retry args that serialize to something other than an object", () => {
    const args = { toJSON: () => [1, 2] };
    const result = validatePluginTaskStart({ title: "T", retry: { actionId: "a.b", args } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/serialize to a JSON object/);
  });

  it("refuses retry args too large or not serializable", () => {
    const big = { blob: "x".repeat(PLUGIN_TASK_RETRY_ARGS_MAX_BYTES) };
    expect(validatePluginTaskStart({ title: "T", retry: { actionId: "a.b", args: big } }).ok).toBe(
      false
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      validatePluginTaskStart({ title: "T", retry: { actionId: "a.b", args: cyclic } }).ok
    ).toBe(false);
  });

  it("does not run a getter on the options", () => {
    const options = { retry };
    Object.defineProperty(options, "title", {
      enumerable: true,
      get() {
        throw new Error("read");
      },
    });
    expect(validatePluginTaskStart(options).ok).toBe(false);
  });
});

describe("validatePluginTaskProgress", () => {
  it("carries only the fields passed, so omitted ones keep their value", () => {
    expect(validatePluginTaskProgress({ fraction: 0.5 })).toEqual({
      ok: true,
      value: { fraction: 0.5 },
    });
    expect(validatePluginTaskProgress({ detail: "" })).toEqual({ ok: true, value: { detail: "" } });
    expect(validatePluginTaskProgress({ fraction: null })).toEqual({
      ok: true,
      value: { fraction: null },
    });
  });

  it("refuses an out-of-range fraction, a multi-line detail and unknown fields", () => {
    expect(validatePluginTaskProgress({ fraction: -0.1 }).ok).toBe(false);
    expect(validatePluginTaskProgress({ detail: "a\nb" }).ok).toBe(false);
    expect(validatePluginTaskProgress({ percent: 3 }).ok).toBe(false);
    expect(validatePluginTaskProgress("50%").ok).toBe(false);
  });
});

describe("validatePluginTaskResult", () => {
  it("needs a message on a failure and refuses one on a cancel", () => {
    expect(validatePluginTaskResult({ outcome: "failed", message: " Offline " })).toEqual({
      ok: true,
      value: { outcome: "failed", message: "Offline" },
    });
    expect(validatePluginTaskResult({ outcome: "failed" }).ok).toBe(false);
    expect(validatePluginTaskResult({ outcome: "failed", message: "  " }).ok).toBe(false);
    expect(validatePluginTaskResult({ outcome: "cancelled", message: "x" }).ok).toBe(false);
    expect(validatePluginTaskResult({ outcome: "cancelled" })).toEqual({
      ok: true,
      value: { outcome: "cancelled" },
    });
  });

  it("drops a blank success message, which then shows nothing", () => {
    expect(validatePluginTaskResult({ outcome: "succeeded", message: " " })).toEqual({
      ok: true,
      value: { outcome: "succeeded" },
    });
  });

  it("refuses an unknown outcome and an overlong message", () => {
    expect(validatePluginTaskResult({ outcome: "done" }).ok).toBe(false);
    expect(
      validatePluginTaskResult({
        outcome: "failed",
        message: "x".repeat(PLUGIN_TASK_MESSAGE_MAX + 1),
      }).ok
    ).toBe(false);
  });
});

describe("mergePluginTaskProgress", () => {
  it("lets the newer report win field by field", () => {
    expect(
      mergePluginTaskProgress({ fraction: 0.1, detail: "1 of 10" }, { fraction: 0.2 })
    ).toEqual({ fraction: 0.2, detail: "1 of 10" });
    expect(mergePluginTaskProgress(undefined, { detail: "" })).toEqual({ detail: "" });
  });
});

describe("inertPluginTaskHandle", () => {
  it("is already aborted, does nothing, and is told apart from an aborted real handle", async () => {
    const handle = inertPluginTaskHandle();
    expect(handle.signal.aborted).toBe(true);
    expect(isInertPluginTaskHandle(handle)).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(
      isInertPluginTaskHandle({
        id: "real",
        signal: controller.signal,
        report: () => {},
        finish: () => Promise.resolve(),
      })
    ).toBe(false);
    expect(() => handle.report({ fraction: 2 })).not.toThrow();
    await expect(handle.finish({ outcome: "succeeded" })).resolves.toBeUndefined();
  });
});

describe("pluginTaskAbortReason", () => {
  it("is an AbortError whose cause round-trips, and anything else reads as interrupted", () => {
    const cancelled = pluginTaskAbortReason("cancelled");
    expect(cancelled).toBeInstanceOf(DOMException);
    expect(cancelled.name).toBe("AbortError");
    expect(pluginTaskAbortCause(cancelled)).toBe("cancelled");
    expect(pluginTaskAbortCause(pluginTaskAbortReason("interrupted"))).toBe("interrupted");
    expect(pluginTaskAbortCause({ cause: "cancelled" })).toBe("cancelled");
    expect(pluginTaskAbortCause(new DOMException("x", "AbortError"))).toBe("interrupted");
    expect(pluginTaskAbortCause(null)).toBe("interrupted");
    expect(pluginTaskAbortCause(inertPluginTaskHandle().signal.reason)).toBe("interrupted");
  });
});
