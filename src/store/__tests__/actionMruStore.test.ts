// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients/appClient", () => ({
  appClient: {
    setState: vi.fn(),
  },
}));

import { useActionMruStore } from "../actionMruStore";

describe("actionMruStore", () => {
  beforeEach(() => {
    useActionMruStore.setState({ actionMruList: [] });
  });

  it("records a new action to the front of the MRU list", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    expect(useActionMruStore.getState().actionMruList).toEqual(["a.action"]);

    useActionMruStore.getState().recordActionMru("b.action");
    expect(useActionMruStore.getState().actionMruList).toEqual(["b.action", "a.action"]);
  });

  it("moves an existing action to the front (deduplicates)", () => {
    useActionMruStore.setState({ actionMruList: ["b.action", "a.action"] });

    useActionMruStore.getState().recordActionMru("a.action");
    expect(useActionMruStore.getState().actionMruList).toEqual(["a.action", "b.action"]);
  });

  it("caps the MRU list at 20 entries", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `action.${i}`);
    for (const id of ids) {
      useActionMruStore.getState().recordActionMru(id);
    }

    expect(useActionMruStore.getState().actionMruList.length).toBe(20);
    expect(useActionMruStore.getState().actionMruList[0]).toBe("action.24");
  });

  it("hydrates the MRU list and truncates to max size", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `action.${i}`);
    useActionMruStore.getState().hydrateActionMru(ids);

    const hydrated = useActionMruStore.getState().actionMruList;
    expect(hydrated.length).toBe(20);
    expect(hydrated[0]).toBe("action.0");
    expect(hydrated[19]).toBe("action.19");
  });

  it("clears the MRU list", () => {
    useActionMruStore.setState({ actionMruList: ["a.action", "b.action"] });

    useActionMruStore.getState().clearActionMru();
    expect(useActionMruStore.getState().actionMruList).toEqual([]);
  });

  it("returns same state when recording the same top item", () => {
    useActionMruStore.setState({ actionMruList: ["a.action", "b.action"] });
    const before = useActionMruStore.getState().actionMruList;

    useActionMruStore.getState().recordActionMru("a.action");
    const after = useActionMruStore.getState().actionMruList;

    expect(before).toBe(after);
  });
});
