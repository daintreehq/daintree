import { describe, expect, it } from "vitest";
import type { RequestRecord } from "../src/contracts";
import { draftFrom, draftStanding, encodeDraft, readDraft } from "../src/views/draft";

const REQUEST: RequestRecord = {
  id: "demo-1",
  title: "Add dark mode",
  status: "open",
  notes: "",
  revision: 4,
  createdAt: "2026-01-05T09:00:00.000Z",
  updatedAt: "2026-01-05T09:00:00.000Z",
};

describe("request drafts", () => {
  it("round-trips through the view's durable state", () => {
    const draft = { ...draftFrom(REQUEST), title: "Add dark mode everywhere" };
    expect(readDraft(encodeDraft(draft))).toEqual(draft);
    expect(readDraft(encodeDraft(null))).toBeNull();
  });

  it("drops a draft an older or newer build wrote rather than half-restoring it", () => {
    const state = encodeDraft(draftFrom(REQUEST)) as { draft: Record<string, unknown> };
    expect(readDraft({ draft: { ...state.draft, v: 0 } })).toBeNull();
    expect(readDraft({ draft: { ...state.draft, status: "archived" } })).toBeNull();
    expect(readDraft(undefined)).toBeNull();
  });

  it("tells a pending edit from one someone else's write overtook, or whose request is gone", () => {
    const edited = { ...draftFrom(REQUEST), notes: "Started" };
    expect(draftStanding(edited, REQUEST)).toBe("pending");
    expect(draftStanding(edited, { ...REQUEST, revision: 5, title: "Renamed" })).toBe("overtaken");
    expect(draftStanding(edited, null)).toBe("orphaned");
    expect(draftStanding(draftFrom(REQUEST), REQUEST)).toBe("clean");
    expect(draftStanding(null, REQUEST)).toBe("clean");
  });
});
