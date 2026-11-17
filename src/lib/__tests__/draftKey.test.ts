import { describe, expect, it } from "vitest";
import { hasDraftText, isolatedComposerScope, isTerminalDraftKey, makeDraftKey } from "../draftKey";

const OTHER_HOST_KEY = makeDraftKey("term-1", isolatedComposerScope("host-b"));

describe("isTerminalDraftKey", () => {
  it("matches the terminal's bare, project-scoped and isolated keys", () => {
    expect(isTerminalDraftKey("term-1", "term-1")).toBe(true);
    expect(isTerminalDraftKey(makeDraftKey("term-1", "project-a"), "term-1")).toBe(true);
    expect(isTerminalDraftKey(makeDraftKey("term-1", isolatedComposerScope()), "term-1")).toBe(
      true
    );
  });

  it("leaves out a draft for another host's terminal of the same id", () => {
    expect(isTerminalDraftKey(OTHER_HOST_KEY, "term-1")).toBe(false);
  });

  it("takes an isolated key whole for a local id that holds a colon", () => {
    const localKey = makeDraftKey("agent:1", isolatedComposerScope());
    expect(isTerminalDraftKey(localKey, "agent:1")).toBe(true);
    expect(
      isTerminalDraftKey(makeDraftKey("agent:1", isolatedComposerScope("host-b")), "agent:1")
    ).toBe(false);
  });

  it("leaves out a terminal whose id only ends the same way", () => {
    expect(isTerminalDraftKey(makeDraftKey("term-10", "project-a"), "term-1")).toBe(false);
    expect(isTerminalDraftKey(makeDraftKey("xterm-1", "project-a"), "term-1")).toBe(false);
  });
});

describe("hasDraftText", () => {
  it("finds the terminal's draft under any of its own scopes", () => {
    for (const key of [
      "term-1",
      makeDraftKey("term-1", "project-a"),
      makeDraftKey("term-1", isolatedComposerScope()),
    ]) {
      expect(hasDraftText(new Map([[key, "hello"]]), "term-1")).toBe(true);
    }
  });

  it("ignores another host's draft for a terminal of the same id", () => {
    const drafts = new Map([
      [OTHER_HOST_KEY, "a reply to the other host"],
      [makeDraftKey("term-1", "project-a"), "  \n"],
      [makeDraftKey("term-2", "project-a"), "another pane's draft"],
    ]);
    expect(hasDraftText(drafts, "term-1")).toBe(false);
  });

  it("finds a colon-holding id's own isolated draft, never another host's", () => {
    const remote = new Map([[makeDraftKey("agent:1", isolatedComposerScope("host-b")), "reply"]]);
    expect(hasDraftText(remote, "agent:1")).toBe(false);
    remote.set(makeDraftKey("agent:1", isolatedComposerScope()), "here");
    expect(hasDraftText(remote, "agent:1")).toBe(true);
  });
});
