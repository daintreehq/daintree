// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetHostLocalState, installForgetHostLocalState } from "../forgetHostLocalState";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useTwoPaneSplitStore } from "@/store/twoPaneSplitStore";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

const LOCAL = "a".repeat(64);

function seed(): void {
  useCommandHistoryStore.setState({
    history: { "studio:p1": [], "studio-2:p1": [], [LOCAL]: [] },
  });
  useUrlHistoryStore.setState({ entries: { "studio:p1": [], [LOCAL]: [] } });
  useTwoPaneSplitStore.setState({
    ratioByWorktreeId: {
      "studio:wt": { ratio: 0.5, panels: ["a", "b"] },
      "studio-2:wt": { ratio: 0.4, panels: ["a", "b"] },
    },
  });
  localStorage.setItem("daintree_cmd_history_studio:p1", "[]");
  localStorage.setItem("daintree_quickrun_expanded_studio:p1", "true");
  localStorage.setItem("daintree_quickrun_autorestart_studio-2:p1", "true");
  localStorage.setItem(`daintree_quickrun_expanded_${LOCAL}`, "true");
  localStorage.setItem("unrelated_studio:p1", "kept");
}

describe("forgetHostLocalState", () => {
  beforeEach(() => {
    localStorage.clear();
    seed();
  });

  it("drops the removed host's entries from every store and QuickRun key, and nothing else", () => {
    forgetHostLocalState("studio");

    expect(Object.keys(useCommandHistoryStore.getState().history).sort()).toEqual(
      [LOCAL, "studio-2:p1"].sort()
    );
    expect(Object.keys(useUrlHistoryStore.getState().entries)).toEqual([LOCAL]);
    expect(Object.keys(useTwoPaneSplitStore.getState().ratioByWorktreeId)).toEqual(["studio-2:wt"]);
    expect(localStorage.getItem("daintree_cmd_history_studio:p1")).toBeNull();
    expect(localStorage.getItem("daintree_quickrun_expanded_studio:p1")).toBeNull();
    expect(localStorage.getItem("daintree_quickrun_autorestart_studio-2:p1")).toBe("true");
    expect(localStorage.getItem(`daintree_quickrun_expanded_${LOCAL}`)).toBe("true");
    expect(localStorage.getItem("unrelated_studio:p1")).toBe("kept");
  });

  it("leaves a store untouched when it holds nothing of the host", () => {
    const before = useUrlHistoryStore.getState().entries;
    forgetHostLocalState("elsewhere");
    expect(useUrlHistoryStore.getState().entries).toBe(before);
  });
});

describe("installForgetHostLocalState", () => {
  let listener: ((event: RemoteHostsEvent) => void) | null = null;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    seed();
    vi.stubGlobal("electron", {
      remoteHosts: {
        onEvent: (callback: (event: RemoteHostsEvent) => void) => {
          listener = callback;
          return unsubscribe;
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears a host when main says it was removed, and ignores other events", () => {
    const dispose = installForgetHostLocalState();
    listener!({ type: "project-offer" });
    expect(useUrlHistoryStore.getState().entries).toHaveProperty("studio:p1");
    listener!({ type: "host-forgotten", hostId: "studio" });
    expect(useUrlHistoryStore.getState().entries).not.toHaveProperty("studio:p1");
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
