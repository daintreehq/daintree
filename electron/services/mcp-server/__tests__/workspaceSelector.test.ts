import { describe, it, expect } from "vitest";
import { parseWorkspaceSelector } from "../workspaceSelector.js";

/**
 * The handshake selector matrix (#11789). Every "reject" outcome here means no
 * session is created at all, so these cases are the difference between a client
 * knowing its calls are unscoped and a client wrongly believing they are scoped.
 */
describe("parseWorkspaceSelector (#11789)", () => {
  it("reports absent when neither spelling is present", () => {
    expect(parseWorkspaceSelector(undefined, [])).toEqual({ kind: "absent" });
  });

  it("reads the header alone", () => {
    expect(parseWorkspaceSelector("ws-a", [])).toEqual({ kind: "selector", workspaceId: "ws-a" });
  });

  it("reads the query param alone", () => {
    expect(parseWorkspaceSelector(undefined, ["ws-a"])).toEqual({
      kind: "selector",
      workspaceId: "ws-a",
    });
  });

  it("accepts both spellings when they agree", () => {
    expect(parseWorkspaceSelector("ws-a", ["ws-a"])).toEqual({
      kind: "selector",
      workspaceId: "ws-a",
    });
  });

  it("trims transport whitespace before comparing, so a padded copy still agrees", () => {
    expect(parseWorkspaceSelector("  ws-a  ", ["ws-a"])).toEqual({
      kind: "selector",
      workspaceId: "ws-a",
    });
  });

  it("rejects disagreeing spellings rather than picking one", () => {
    const result = parseWorkspaceSelector("ws-a", ["ws-b"]);
    expect(result.kind).toBe("reject");
    expect(result.kind === "reject" && result.rejection.code).toBe("WORKSPACE_SELECTOR_MISMATCH");
  });

  it.each([
    ["a whitespace-only header", "   " as string | undefined, [] as string[]],
    ["an empty header", "", []],
    ["an empty query param", undefined, [""]],
    ["a whitespace-only query param", undefined, ["  "]],
  ])("rejects %s rather than reading it as no selector", (_label, header, query) => {
    // Fail-open here is the whole bug class: a client that sent the field at
    // all believes it is scoped, and "absent" would hand it a focus-following
    // session while it thought otherwise.
    const result = parseWorkspaceSelector(header, query);
    expect(result.kind).toBe("reject");
    expect(result.kind === "reject" && result.rejection.code).toBe("WORKSPACE_SELECTOR_INVALID");
  });

  it("rejects a blank header even when a valid query param is present", () => {
    const result = parseWorkspaceSelector("", ["ws-a"]);
    expect(result.kind).toBe("reject");
  });

  it("rejects a comma-folded header instead of splitting it", () => {
    // Node folds a repeated header into one comma-joined string, so this is
    // indistinguishable from two different workspaces being requested.
    const result = parseWorkspaceSelector("ws-a,ws-b", []);
    expect(result.kind).toBe("reject");
    expect(result.kind === "reject" && result.rejection.code).toBe("WORKSPACE_SELECTOR_INVALID");
  });

  it("rejects a header Node delivered as an array of more than one value", () => {
    const result = parseWorkspaceSelector(["ws-a", "ws-b"], []);
    expect(result.kind).toBe("reject");
    expect(result.kind === "reject" && result.rejection.code).toBe("WORKSPACE_SELECTOR_INVALID");
  });

  it("accepts a single-element array header", () => {
    expect(parseWorkspaceSelector(["ws-a"], [])).toEqual({
      kind: "selector",
      workspaceId: "ws-a",
    });
  });

  it("rejects a repeated query param", () => {
    const result = parseWorkspaceSelector(undefined, ["ws-a", "ws-b"]);
    expect(result.kind).toBe("reject");
    expect(result.kind === "reject" && result.rejection.code).toBe("WORKSPACE_SELECTOR_INVALID");
  });

  it("rejects a repeated query param even when both copies agree", () => {
    // Two identical values still mean the client's config is producing the
    // parameter twice, which is a bug worth surfacing rather than papering over.
    const result = parseWorkspaceSelector(undefined, ["ws-a", "ws-a"]);
    expect(result.kind).toBe("reject");
  });

  it("names the header and param in its rejection copy, so the message can't rot", () => {
    const mismatch = parseWorkspaceSelector("ws-a", ["ws-b"]);
    expect(mismatch.kind === "reject" && mismatch.rejection.message).toContain(
      "Daintree-Workspace-Id"
    );
    expect(mismatch.kind === "reject" && mismatch.rejection.message).toContain("workspaceId");
  });

  it("keeps the id opaque — no path or format interpretation", () => {
    const pathish = "/Users/someone/code/project";
    expect(parseWorkspaceSelector(pathish, [])).toEqual({
      kind: "selector",
      workspaceId: pathish,
    });
  });
});
