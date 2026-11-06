import { describe, expect, it, vi } from "vitest";
import { ComposerDrafts } from "../composerDrafts.js";

describe("ComposerDrafts (#16282)", () => {
  it("finds a terminal's draft under any scope its key carries", () => {
    const drafts = new ComposerDrafts();
    drafts.report("view-1", ["project-1:t1", "t2", "isolated-composer:host-2:t3"]);
    expect(drafts.hasDraft("t1")).toBe(true);
    expect(drafts.hasDraft("t2")).toBe(true);
    expect(drafts.hasDraft("t3")).toBe(true);
    // A suffix of an id is a different terminal.
    expect(drafts.hasDraft("1")).toBe(false);
  });

  it("keeps a draft while any view holds one, and tells listeners when one empties", () => {
    const drafts = new ComposerDrafts();
    const cleared = vi.fn();
    drafts.onCleared(cleared);
    drafts.report("view-1", ["p:t1"]);
    drafts.report("view-2", ["p:t1"]);
    expect(cleared).not.toHaveBeenCalled();

    drafts.report("view-1", []);
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(drafts.hasDraft("t1")).toBe(true);

    drafts.dropView("view-2");
    expect(cleared).toHaveBeenCalledTimes(2);
    expect(drafts.hasDraft("t1")).toBe(false);
  });

  it("says nothing when a view only adds drafts, or drops a view that held none", () => {
    const drafts = new ComposerDrafts();
    const cleared = vi.fn();
    const off = drafts.onCleared(cleared);
    drafts.report("view-1", ["p:t1"]);
    drafts.report("view-1", ["p:t1", "p:t2"]);
    drafts.dropView("view-9");
    expect(cleared).not.toHaveBeenCalled();

    off();
    drafts.report("view-1", []);
    expect(cleared).not.toHaveBeenCalled();
  });
});
