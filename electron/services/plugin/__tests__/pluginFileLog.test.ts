import { describe, expect, it } from "vitest";
import {
  PLUGIN_FILE_LOG_TEXT_MAX_CHARS,
  PluginFileLogLimiter,
  boundPluginFileLogText,
  pluginFileLogIdentity,
  type PluginFileLogLimiterOptions,
} from "../pluginFileLog.js";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";

function limiter(overrides: Partial<PluginFileLogLimiterOptions> = {}) {
  const clock = { t: 1_000 };
  const instance = new PluginFileLogLimiter({
    windowMs: 1_000,
    perPlugin: { error: 2, warn: 2, lifecycle: 2 },
    global: { error: 3, warn: 3, lifecycle: 3 },
    now: () => clock.t,
    ...overrides,
  });
  return { instance, clock };
}

describe("pluginFileLogIdentity", () => {
  it("splits a project instance key into manifest id and project", () => {
    const key = makeProjectPluginInstanceKey("a".repeat(64), "acme.demo");
    expect(pluginFileLogIdentity(key)).toEqual({
      pluginId: "acme.demo",
      projectId: "a".repeat(64),
      instanceKey: key,
    });
  });

  it("keeps an installed plugin id as-is with no project", () => {
    expect(pluginFileLogIdentity("acme.installed")).toEqual({ pluginId: "acme.installed" });
  });
});

describe("boundPluginFileLogText", () => {
  it("scrubs secrets", () => {
    const token = `ghp_${"0123456789abcdefghijklmnopqrstuvwxyz"}`;
    const out = boundPluginFileLogText(`auth ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("caps by codepoint without leaving a lone surrogate", () => {
    const out = boundPluginFileLogText("😀".repeat(PLUGIN_FILE_LOG_TEXT_MAX_CHARS + 50));
    const codepoints = Array.from(out);
    expect(codepoints).toHaveLength(PLUGIN_FILE_LOG_TEXT_MAX_CHARS);
    expect(codepoints.at(-1)).toBe("…");
    expect(codepoints.slice(0, -1).every((c) => c === "😀")).toBe(true);
  });

  it("leaves short text untouched", () => {
    expect(boundPluginFileLogText("boom")).toBe("boom");
  });
});

describe("PluginFileLogLimiter", () => {
  it("admits up to the per-plugin budget, then counts what it drops", () => {
    const { instance, clock } = limiter();
    expect(instance.admit("p", "error").admitted).toBe(true);
    expect(instance.admit("p", "error").admitted).toBe(true);
    expect(instance.admit("p", "error").admitted).toBe(false);
    expect(instance.admit("p", "error").admitted).toBe(false);

    clock.t += 1_000;
    const next = instance.admit("p", "error");
    expect(next).toEqual({ admitted: true, suppressedInPreviousWindow: { error: 2 } });
  });

  it("keeps separate budgets per category so warnings cannot starve errors", () => {
    const { instance } = limiter();
    instance.admit("p", "warn");
    instance.admit("p", "warn");
    expect(instance.admit("p", "warn").admitted).toBe(false);
    expect(instance.admit("p", "error").admitted).toBe(true);
    expect(instance.admit("p", "lifecycle").admitted).toBe(true);
  });

  it("caps the total across plugins", () => {
    const { instance } = limiter();
    expect(instance.admit("a", "warn").admitted).toBe(true);
    expect(instance.admit("b", "warn").admitted).toBe(true);
    expect(instance.admit("c", "warn").admitted).toBe(true);
    expect(instance.admit("d", "warn").admitted).toBe(false);
  });

  it("does not spend a plugin's budget on a line the global cap refused", () => {
    const { instance, clock } = limiter({
      perPlugin: { error: 2, warn: 2, lifecycle: 2 },
      global: { error: 1, warn: 1, lifecycle: 1 },
    });
    expect(instance.admit("a", "error").admitted).toBe(true);
    expect(instance.admit("b", "error").admitted).toBe(false);

    clock.t += 1_000;
    // `b` still has its whole allowance in the new window.
    expect(instance.admit("b", "error").admitted).toBe(true);
  });

  it("reports no summary when nothing was dropped", () => {
    const { instance, clock } = limiter();
    instance.admit("p", "warn");
    clock.t += 1_000;
    expect(instance.admit("p", "warn")).toEqual({ admitted: true });
  });

  it("drain returns the open window's drops and forgets the plugin", () => {
    const { instance } = limiter();
    instance.admit("p", "warn");
    instance.admit("p", "warn");
    instance.admit("p", "warn");
    expect(instance.drain("p")).toEqual({ warn: 1 });
    expect(instance.drain("p")).toBeUndefined();
    // A reload starts with a fresh per-plugin allowance.
    expect(instance.admit("p", "warn").admitted).toBe(true);
  });

  it("does not let a reload reset the global cap", () => {
    const { instance } = limiter();
    instance.admit("p", "error");
    instance.admit("p", "error");
    instance.drain("p");
    expect(instance.admit("p", "error").admitted).toBe(true);
    expect(instance.admit("p", "error").admitted).toBe(false);
  });
});
