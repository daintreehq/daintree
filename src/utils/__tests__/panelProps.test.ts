import { describe, it, expect } from "vitest";
import { buildPanelProps } from "../panelProps";
import type { TerminalInstance } from "@/store";

const noop = () => {};

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t-1",
    title: "Terminal 1",
    worktreeId: "w-1",
    type: "interactive",
    agentId: undefined,
    cwd: "/tmp",
    agentState: undefined,
    activityHeadline: undefined,
    activityStatus: undefined,
    activityType: undefined,
    lastCommand: undefined,
    flowStatus: undefined,
    restartKey: undefined,
    restartError: undefined,
    reconnectError: undefined,
    spawnError: undefined,
    detectedProcessId: undefined,
    browserUrl: undefined,
    ...overrides,
  } as TerminalInstance;
}

function build(terminal: TerminalInstance) {
  return buildPanelProps({
    terminal,
    isFocused: false,
    isTrashing: false,
    overrides: { onFocus: noop, onClose: noop },
  });
}

describe("buildPanelProps activity stabilization", () => {
  it("returns the same activity reference when fields are unchanged", () => {
    const terminal = makeTerminal({
      id: "stable-1",
      activityHeadline: "Running tests",
      activityStatus: "working",
      activityType: "interactive",
    });
    const a = build(terminal).activity;
    const b = build(terminal).activity;
    expect(a).toBe(b);
  });

  it("treats undefined status/type as defaults and returns stable reference", () => {
    const withDefaults = makeTerminal({
      id: "defaults-1",
      activityHeadline: "Building",
      activityStatus: "working",
      activityType: "interactive",
    });
    const withUndefined = makeTerminal({
      id: "defaults-1",
      activityHeadline: "Building",
      activityStatus: undefined,
      activityType: undefined,
    });
    const a = build(withDefaults).activity;
    const b = build(withUndefined).activity;
    expect(a).toBe(b);
  });

  it("returns a new reference when headline changes", () => {
    const id = "change-headline";
    const a = build(makeTerminal({ id, activityHeadline: "First" })).activity;
    const b = build(makeTerminal({ id, activityHeadline: "Second" })).activity;
    expect(a).not.toBe(b);
    expect(b).toEqual({ headline: "Second", status: "working", type: "interactive" });
  });

  it("returns a new reference when status changes", () => {
    const id = "change-status";
    const a = build(
      makeTerminal({ id, activityHeadline: "Test", activityStatus: "working" })
    ).activity;
    const b = build(
      makeTerminal({ id, activityHeadline: "Test", activityStatus: "success" })
    ).activity;
    expect(a).not.toBe(b);
    expect(b!.status).toBe("success");
  });

  it("returns a new reference when type changes", () => {
    const id = "change-type";
    const a = build(
      makeTerminal({ id, activityHeadline: "Test", activityType: "interactive" })
    ).activity;
    const b = build(
      makeTerminal({ id, activityHeadline: "Test", activityType: "background" })
    ).activity;
    expect(a).not.toBe(b);
    expect(b!.type).toBe("background");
  });

  it("returns null when activityHeadline is falsy", () => {
    const result = build(makeTerminal({ id: "null-1", activityHeadline: undefined }));
    expect(result.activity).toBeNull();
  });

  it("returns null for empty-string headline", () => {
    const result = build(makeTerminal({ id: "null-2", activityHeadline: "" }));
    expect(result.activity).toBeNull();
  });

  it("isolates caches by terminal ID", () => {
    const termA = makeTerminal({
      id: "iso-a",
      activityHeadline: "Same",
      activityStatus: "working",
    });
    const termB = makeTerminal({
      id: "iso-b",
      activityHeadline: "Same",
      activityStatus: "working",
    });
    const a = build(termA).activity;
    const b = build(termB).activity;
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("transitions from object to null", () => {
    const id = "transition-to-null";
    const a = build(makeTerminal({ id, activityHeadline: "Active" })).activity;
    expect(a).not.toBeNull();
    const b = build(makeTerminal({ id, activityHeadline: undefined })).activity;
    expect(b).toBeNull();
  });

  it("transitions from null to object", () => {
    const id = "transition-to-obj";
    const a = build(makeTerminal({ id, activityHeadline: undefined })).activity;
    expect(a).toBeNull();
    const b = build(makeTerminal({ id, activityHeadline: "Now active" })).activity;
    expect(b).toEqual({ headline: "Now active", status: "working", type: "interactive" });
  });
});
