// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCommandHistoryStore } from "../commandHistoryStore";
import { useUrlHistoryStore } from "../urlHistoryStore";
import { useTwoPaneSplitStore } from "../twoPaneSplitStore";

function reset(): void {
  useCommandHistoryStore.setState({ history: {} });
  useUrlHistoryStore.setState({ entries: {} });
  useTwoPaneSplitStore.setState({ ratioByWorktreeId: {} });
}

describe("per-project persisted keys", () => {
  beforeEach(reset);
  afterEach(() => {
    delete window.__DAINTREE_HOST_ID__;
    reset();
  });

  it("stay bare in a local window", () => {
    useCommandHistoryStore.getState().recordPrompt("proj1", "fix it", null);
    useUrlHistoryStore.getState().recordVisit("proj1", "http://localhost:5173/", "Dev");
    useTwoPaneSplitStore.getState().setWorktreeRatio("/repo/wt", 0.4, ["a", "b"]);

    expect(Object.keys(useCommandHistoryStore.getState().history)).toEqual(["proj1"]);
    expect(Object.keys(useUrlHistoryStore.getState().entries)).toEqual(["proj1"]);
    expect(Object.keys(useTwoPaneSplitStore.getState().ratioByWorktreeId)).toEqual(["/repo/wt"]);
  });

  it("carry the host id in a remote window and read back through the same key", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    useCommandHistoryStore.getState().recordPrompt("proj1", "fix it", null);
    useUrlHistoryStore.getState().recordVisit("proj1", "http://localhost:5173/", "Dev");
    useTwoPaneSplitStore.getState().setWorktreeRatio("/repo/wt", 0.4, ["a", "b"]);

    expect(Object.keys(useCommandHistoryStore.getState().history)).toEqual(["studio-01:proj1"]);
    expect(Object.keys(useUrlHistoryStore.getState().entries)).toEqual(["studio-01:proj1"]);
    expect(Object.keys(useTwoPaneSplitStore.getState().ratioByWorktreeId)).toEqual([
      "studio-01:/repo/wt",
    ]);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj1")).toHaveLength(1);
    expect(useTwoPaneSplitStore.getState().getWorktreeRatio("/repo/wt")).toBe(0.4);

    useCommandHistoryStore.getState().removeProjectHistory("proj1");
    useUrlHistoryStore.getState().removeProjectHistory("proj1");
    useTwoPaneSplitStore.getState().resetWorktreeRatio("/repo/wt");
    expect(useCommandHistoryStore.getState().history).toEqual({});
    expect(useUrlHistoryStore.getState().entries).toEqual({});
    expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toEqual({});
  });

  it("do not let a remote project read a local project's history under the same id", () => {
    useCommandHistoryStore.getState().recordPrompt("proj1", "local prompt", null);
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    expect(useCommandHistoryStore.getState().getProjectHistory("proj1")).toEqual([]);
  });
});
