// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetHostLocalState, installForgetHostLocalState } from "../forgetHostLocalState";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useTwoPaneSplitStore } from "@/store/twoPaneSplitStore";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { backupKeyFor } from "@/store/persistence/safeStorage";

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

  it("scrubs entries only another view knew, from each stored copy and its backup", () => {
    const stores = [
      { name: useCommandHistoryStore.persist.getOptions().name!, field: "history" },
      { name: useUrlHistoryStore.persist.getOptions().name!, field: "entries" },
      { name: useTwoPaneSplitStore.persist.getOptions().name!, field: "ratioByWorktreeId" },
    ];
    // Each store keeps only well-formed entries when it next writes.
    const value = (field: string) =>
      field === "ratioByWorktreeId" ? { ratio: 0.4, panels: ["a", "b"] } : ["entry"];
    const stored = (field: string) =>
      JSON.stringify({
        state: {
          [field]: { "studio:disk-only": value(field), "studio-2:disk-only": value(field) },
          other: 1,
        },
        version: 3,
      });
    for (const { name, field } of stores) {
      localStorage.setItem(name, stored(field));
      localStorage.setItem(backupKeyFor(name), stored(field));
    }
    localStorage.setItem("daintree:host-build-noticed:studio\u00001.0\u0000abc", "1");
    localStorage.setItem("daintree:host-build-noticed:studio-2\u00001.0\u0000abc", "1");

    forgetHostLocalState("studio");

    for (const { name, field } of stores) {
      for (const key of [name, backupKeyFor(name)]) {
        // The store's own write may follow and reshape the blob; what must hold
        // is that no copy keeps the removed host and the other host's entry stays.
        const parsed: unknown = JSON.parse(localStorage.getItem(key)!);
        const state: unknown =
          parsed && typeof parsed === "object" ? Reflect.get(parsed, "state") : null;
        const record: unknown =
          state && typeof state === "object" ? Reflect.get(state, field) : null;
        const keys = Object.keys(record ?? {});
        expect(keys.filter((k) => k.startsWith("studio:"))).toEqual([]);
        // The split store's own write keeps only what this view holds; the
        // history stores also keep entries another view wrote.
        if (field !== "ratioByWorktreeId") expect(keys).toContain("studio-2:disk-only");
      }
    }
    expect(localStorage.getItem("daintree:host-build-noticed:studio\u00001.0\u0000abc")).toBeNull();
    expect(localStorage.getItem("daintree:host-build-noticed:studio-2\u00001.0\u0000abc")).toBe(
      "1"
    );
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
