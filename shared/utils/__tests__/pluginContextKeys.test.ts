import { describe, expect, it } from "vitest";
import {
  PLUGIN_CONTEXT_KEYS_MAX,
  PLUGIN_CONTEXT_KEY_LENGTH_MAX,
  PLUGIN_CONTEXT_VALUE_LENGTH_MAX,
  makeProjectPluginInstanceKey,
  type PluginContextValue,
} from "../../types/plugin.js";
import {
  applyPluginContextEntry,
  buildPluginWhenContext,
  validatePluginContextEntry,
} from "../pluginContextKeys.js";
import { evaluate, parse } from "../whenClause/index.js";

describe("validatePluginContextEntry", () => {
  it("accepts booleans, strings (including empty) and clears on null or undefined", () => {
    expect(validatePluginContextEntry("needsYou", true)).toEqual({
      ok: true,
      key: "needsYou",
      value: true,
    });
    expect(validatePluginContextEntry("mode", "")).toEqual({ ok: true, key: "mode", value: "" });
    expect(validatePluginContextEntry("busy", false)).toEqual({
      ok: true,
      key: "busy",
      value: false,
    });
    expect(validatePluginContextEntry("busy", null)).toEqual({
      ok: true,
      key: "busy",
      value: null,
    });
    expect(validatePluginContextEntry("busy", undefined)).toEqual({
      ok: true,
      key: "busy",
      value: null,
    });
  });

  it("accepts hyphens, underscores and digits after the first character", () => {
    for (const key of ["a", "_x", "needs-you", "queue_2", "A-b_3"]) {
      expect(validatePluginContextEntry(key, true).ok).toBe(true);
    }
  });

  it("rejects keys a when clause could not reach as one leaf", () => {
    for (const key of [
      "",
      "a.b",
      "2fa",
      "-x",
      "has space",
      "ü",
      "a!",
      "__proto__",
      "constructor",
    ]) {
      expect(validatePluginContextEntry(key, true).ok).toBe(false);
    }
    expect(validatePluginContextEntry(42, true).ok).toBe(false);
  });

  it("bounds key and string-value length exactly at the limits", () => {
    const longestKey = "k".repeat(PLUGIN_CONTEXT_KEY_LENGTH_MAX);
    expect(validatePluginContextEntry(longestKey, true).ok).toBe(true);
    expect(validatePluginContextEntry(`${longestKey}k`, true).ok).toBe(false);

    const longestValue = "v".repeat(PLUGIN_CONTEXT_VALUE_LENGTH_MAX);
    expect(validatePluginContextEntry("k", longestValue).ok).toBe(true);
    expect(validatePluginContextEntry("k", `${longestValue}v`).ok).toBe(false);
  });

  it("rejects values that are not a boolean, a string or null", () => {
    for (const value of [0, 1, {}, [], Symbol("x"), () => true]) {
      expect(validatePluginContextEntry("k", value).ok).toBe(false);
    }
  });
});

describe("applyPluginContextEntry", () => {
  it("reports whether the map actually changed", () => {
    const keys = new Map<string, PluginContextValue>();
    expect(applyPluginContextEntry(keys, "a", true)).toEqual({ ok: true, changed: true });
    expect(applyPluginContextEntry(keys, "a", true)).toEqual({ ok: true, changed: false });
    expect(applyPluginContextEntry(keys, "a", "true")).toEqual({ ok: true, changed: true });
    expect(applyPluginContextEntry(keys, "a", null)).toEqual({ ok: true, changed: true });
    expect(applyPluginContextEntry(keys, "a", null)).toEqual({ ok: true, changed: false });
    expect(keys.size).toBe(0);
  });

  it("refuses a new key at the cap but still allows replacing and clearing", () => {
    const keys = new Map<string, PluginContextValue>();
    for (let i = 0; i < PLUGIN_CONTEXT_KEYS_MAX; i++) {
      expect(applyPluginContextEntry(keys, `k${i}`, true).ok).toBe(true);
    }
    const refused = applyPluginContextEntry(keys, "extra", true);
    expect(refused.ok).toBe(false);
    expect(keys.has("extra")).toBe(false);
    expect(keys.size).toBe(PLUGIN_CONTEXT_KEYS_MAX);

    expect(applyPluginContextEntry(keys, "k0", "replaced")).toEqual({ ok: true, changed: true });
    expect(applyPluginContextEntry(keys, "k1", null)).toEqual({ ok: true, changed: true });
    expect(applyPluginContextEntry(keys, "extra", true)).toEqual({ ok: true, changed: true });
  });
});

type KeysByPlugin = Record<string, Record<string, PluginContextValue>>;

describe("buildPluginWhenContext", () => {
  const holds = (expr: string, keysByPlugin: Parameters<typeof buildPluginWhenContext>[0]) =>
    evaluate(parse(expr), buildPluginWhenContext(keysByPlugin));

  it("nests keys under the manifest name so dotted when clauses reach them", () => {
    const keysByPlugin = {
      "digitalfrontier.beads": { needsYou: true, view: "triage" },
      "acme.linear-planner": { busy: false, mode: "" },
      "3m.2fa-tools": { ready: true },
    };
    expect(holds("digitalfrontier.beads.needsYou", keysByPlugin)).toBe(true);
    expect(holds("digitalfrontier.beads.view == 'triage'", keysByPlugin)).toBe(true);
    expect(holds("acme.linear-planner.busy", keysByPlugin)).toBe(false);
    expect(holds("!acme.linear-planner.mode", keysByPlugin)).toBe(true);
    expect(holds("3m.2fa-tools.ready", keysByPlugin)).toBe(true);
    expect(holds("digitalfrontier.beads.unset", keysByPlugin)).toBe(false);
  });

  it("keeps two plugins under one publisher apart", () => {
    const ctx = buildPluginWhenContext({
      "acme.one": { k: "1" },
      "acme.two": { k: "2" },
    });
    expect(evaluate(parse("acme.one.k == '1' && acme.two.k == '2'"), ctx)).toBe(true);
  });

  it("namespaces a project instance under its bare manifest name", () => {
    const projectKey = makeProjectPluginInstanceKey("proj-1", "acme.beads");
    expect(holds("acme.beads.needsYou", { [projectKey]: { needsYou: true } })).toBe(true);
  });

  it("lets a project instance own its namespace over an installed copy, even with no keys", () => {
    const projectKey = makeProjectPluginInstanceKey("proj-1", "acme.beads");
    // Insertion order must not decide it.
    const projectFirst: KeysByPlugin = {
      [projectKey]: { a: "project" },
      "acme.beads": { a: "installed", b: true },
    };
    expect(holds("acme.beads.a == 'project'", projectFirst)).toBe(true);
    expect(holds("acme.beads.b", projectFirst)).toBe(false);

    const emptyProject: KeysByPlugin = { "acme.beads": { b: true }, [projectKey]: {} };
    expect(holds("acme.beads.b", emptyProject)).toBe(false);
  });

  it("never resolves a path through Object.prototype", () => {
    const ctx = buildPluginWhenContext({ "constructor.proto": { a: true } });
    expect(evaluate(parse("constructor.proto.a"), ctx)).toBe(true);
    expect(Object.getPrototypeOf(ctx)).toBeNull();
    expect(evaluate(parse("toString"), ctx)).toBe(false);
    expect(evaluate(parse("constructor.proto.hasOwnProperty"), ctx)).toBe(false);
  });
});
