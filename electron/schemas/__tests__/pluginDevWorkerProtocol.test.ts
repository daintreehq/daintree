import { describe, expect, it } from "vitest";
import { parseWorkerToHostMessage } from "../pluginDevWorker.js";
import type { PluginWorkerToHostMessage } from "../../../shared/types/pluginDevWorker.js";

const VALID: PluginWorkerToHostMessage[] = [
  { type: "ready" },
  { type: "ready", permission: { present: false } },
  { type: "activated", hasCleanup: true },
  { type: "activate-error", error: "boom" },
  { type: "activate-error", error: "boom", stack: "at <anonymous>" },
  { type: "error", error: "bootstrap failed" },
  { type: "host-call", requestId: "c1", method: "getWorktrees", params: undefined },
  {
    type: "host-call",
    requestId: "c2",
    method: "fs.writeFile",
    params: { path: "/a", contents: "x" },
  },
  { type: "host-cancel", requestId: "c2" },
  { type: "host-notify", method: "logger.info", params: { message: "hi" } },
  {
    type: "host-notify",
    method: "registerAction",
    params: { descriptor: { id: "greet" } },
    registrationKey: "action:greet",
  },
  { type: "subscribe", subscriptionId: "s1", kind: "worktrees", debounceMs: 50 },
  { type: "subscribe", subscriptionId: "s2", kind: "settings", key: "k", scope: "project" },
  { type: "subscribe", subscriptionId: "s3", kind: "process-data", processId: "p1" },
  { type: "unsubscribe", subscriptionId: "s1" },
  { type: "invoke-result", requestId: "i1", ok: true, result: { any: "shape" } },
  { type: "invoke-result", requestId: "i2", ok: false, error: "handler threw" },
];

/** The parsed message, or `null` when the schema rejected it. */
function parsed(raw: unknown): unknown {
  const result = parseWorkerToHostMessage(raw);
  return result.ok ? result.message : null;
}

describe("PluginWorkerToHostMessageSchema", () => {
  it("round-trips every message shape the protocol defines", () => {
    for (const msg of VALID) {
      // Equality, not just acceptance: stripping a declared field (`debounceMs`,
      // `registrationKey`, `permission`) would still "parse" but would silently
      // drop what the bridge reads.
      expect(parsed(msg), JSON.stringify(msg)).toEqual(msg);
    }
  });

  it("tolerates the numbers Zod v4 rejects but the host normalizes", () => {
    // `z.number()` rejects NaN and infinities; the host coerces a nonsense
    // debounce to zero, so rejecting one here would kill a working plugin.
    for (const debounceMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1000]) {
      expect(
        parsed({ type: "subscribe", subscriptionId: "s1", kind: "worktrees", debounceMs }),
        String(debounceMs)
      ).not.toBeNull();
    }
    expect(
      parsed({ type: "subscribe", subscriptionId: "s1", kind: "worktrees", debounceMs: "50" })
    ).toBeNull();
  });

  it("rejects the non-object messages that used to throw at ingress", () => {
    for (const raw of [null, undefined, 0, 42, "host-call", true, [], Symbol("x")]) {
      expect(parsed(raw)).toBeNull();
    }
  });

  it("rejects a missing, unknown or prototype-shaped envelope tag", () => {
    expect(parsed({ requestId: "c1" })).toBeNull();
    expect(parsed({ type: "not-a-real-type" })).toBeNull();
    expect(parsed({ type: "__proto__" })).toBeNull();
    expect(parsed({ type: "constructor" })).toBeNull();
  });

  it("rejects methods outside the finite allowlist", () => {
    expect(parsed({ type: "host-call", requestId: "c1", method: "fs.unlink" })).toBeNull();
    expect(parsed({ type: "host-call", requestId: "c1", method: "constructor" })).toBeNull();
    // A notify method is not a call method, and vice versa.
    expect(parsed({ type: "host-call", requestId: "c1", method: "process.kill" })).toBeNull();
    expect(parsed({ type: "host-notify", method: "fs.readFile" })).toBeNull();
    expect(parsed({ type: "subscribe", subscriptionId: "s1", kind: "everything" })).toBeNull();
  });

  it("rejects missing or empty correlation ids", () => {
    expect(parsed({ type: "host-call", method: "getWorktrees" })).toBeNull();
    expect(parsed({ type: "host-call", requestId: "", method: "getWorktrees" })).toBeNull();
    expect(parsed({ type: "host-call", requestId: 7, method: "getWorktrees" })).toBeNull();
    expect(parsed({ type: "unsubscribe", subscriptionId: "" })).toBeNull();
  });

  it("discriminates invoke-result on `ok` rather than collapsing the two shapes", () => {
    expect(parsed({ type: "invoke-result", requestId: "i1", ok: true })).toEqual({
      type: "invoke-result",
      requestId: "i1",
      ok: true,
    });
    // `ok: false` carries an error string, never a result.
    expect(parsed({ type: "invoke-result", requestId: "i1", ok: false })).toBeNull();
    expect(parsed({ type: "invoke-result", requestId: "i1", ok: "yes" })).toBeNull();
  });

  it("passes opaque payloads through untouched and strips undeclared fields", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const message = parsed({
      type: "host-call",
      requestId: "c1",
      method: "clipboard.writeImage",
      params: { pngData: bytes },
      smuggled: "dropped",
    });
    expect((message as { params: { pngData: Uint8Array } }).params.pngData).toBe(bytes);
    expect(message).not.toHaveProperty("smuggled");
  });

  it("leaves an omitted subscription scope omitted", () => {
    const message = parsed({
      type: "subscribe",
      subscriptionId: "s1",
      kind: "settings",
      key: "k",
    });
    expect(message).not.toHaveProperty("scope");
  });

  it("accepts a call that omits its opaque payload entirely", () => {
    // Zod v4 treats a bare `z.unknown()` as required, so a no-argument call
    // that never sets `params` must stay valid or every such call would be
    // read as a protocol violation.
    expect(parsed({ type: "host-call", requestId: "c1", method: "getWorktrees" })).toEqual({
      type: "host-call",
      requestId: "c1",
      method: "getWorktrees",
    });
    expect(parsed({ type: "host-notify", method: "process.kill" })).not.toBeNull();
    expect(parsed({ type: "invoke-result", requestId: "i1", ok: true })).not.toBeNull();
  });

  it("keeps the offending values out of the rejection summary", () => {
    // The sentinel sits in the INVALID field, so a summary built from Zod's own
    // error text (which can inline the offending value) would fail this.
    const result = parseWorkerToHostMessage({
      type: "activate-error",
      error: { leaked: "s3cret-value" },
      stack: "s3cret-stack",
    });
    expect(result.ok).toBe(false);
    const issues = result.ok ? "" : result.issues;
    expect(issues).not.toContain("s3cret");
    // Paths and codes only.
    expect(issues).toMatch(/^[\w.()]+: [\w-]+(; [\w.()]+: [\w-]+)*$/);
  });

  it("names the field that was wrong rather than collapsing to the union", () => {
    // The top-level union would otherwise report every rejection as
    // "(root): invalid_union", which tells a plugin author nothing.
    const result = parseWorkerToHostMessage({
      type: "activated",
      hasCleanup: "yes",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.issues).toContain("hasCleanup");
  });
});
