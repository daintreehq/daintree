import { afterEach, describe, expect, it } from "vitest";
import { useDevPreviewToolStore } from "../devPreviewToolStore";
import { resetStoreAccessorsForTesting, setPanelStoreAccessor } from "../storeAccessors";

function panels(entries: Record<string, "grid" | "trash">) {
  setPanelStoreAccessor(() => ({
    panelsById: Object.fromEntries(
      Object.entries(entries).map(([id, location]) => [id, { id, kind: "dev-preview", location }])
    ) as never,
    panelIds: Object.keys(entries),
    tabGroups: new Map(),
  }));
}

afterEach(() => {
  resetStoreAccessorsForTesting();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
});

describe("devPreviewToolStore", () => {
  it("forgets tools on previews that were removed or trashed", () => {
    panels({ a: "grid", b: "grid", c: "grid" });
    const { setActive } = useDevPreviewToolStore.getState();
    setActive("a", "tool");
    setActive("b", "tool");
    setActive("c", "tool");

    panels({ a: "grid", b: "trash" });
    useDevPreviewToolStore.getState().toggle("a", "other");
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({ a: "other" });
  });
});
