import { beforeEach, describe, expect, it } from "vitest";
import { useFileBrowserDraftReviewStore } from "../fileBrowserDraftReviewStore";

const store = () => useFileBrowserDraftReviewStore.getState();

beforeEach(() => {
  useFileBrowserDraftReviewStore.setState({ byPanelId: {} });
});

describe("fileBrowserDraftReviewStore (#17197)", () => {
  it("lets settling an older request leave a newer one for the same panel waiting", () => {
    store().requestReview("fb", "a.md");
    const older = store().byPanelId.fb!;
    store().requestReview("fb", "b.md");
    const newer = store().byPanelId.fb!;

    store().settleReview("fb", older.seq);
    expect(store().byPanelId.fb).toBe(newer);

    store().settleReview("fb", newer.seq);
    expect(store().byPanelId.fb).toBeUndefined();
  });

  it("keeps each panel's request apart", () => {
    store().requestReview("fb-1", "a.md");
    store().requestReview("fb-2", "b.md");
    const second = store().byPanelId["fb-2"];

    store().settleReview("fb-1", store().byPanelId["fb-1"]!.seq);

    expect(store().byPanelId["fb-1"]).toBeUndefined();
    expect(store().byPanelId["fb-2"]).toBe(second);
  });
});
