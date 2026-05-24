// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients/appClient", () => ({
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
}));

import { useActionPrefsStore } from "../actionPrefsStore";

describe("actionPrefsStore", () => {
  beforeEach(() => {
    useActionPrefsStore.setState({ pinnedActionIds: [], hiddenActionIds: [] });
  });

  describe("pinAction", () => {
    it("adds an id to pinnedActionIds", () => {
      useActionPrefsStore.getState().pinAction("worktree.create");
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["worktree.create"]);
    });

    it("is idempotent — pinning the same id twice keeps a single entry", () => {
      useActionPrefsStore.getState().pinAction("worktree.create");
      useActionPrefsStore.getState().pinAction("worktree.create");
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["worktree.create"]);
    });

    it("preserves insertion order across multiple pins", () => {
      useActionPrefsStore.getState().pinAction("a.one");
      useActionPrefsStore.getState().pinAction("a.two");
      useActionPrefsStore.getState().pinAction("a.three");
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["a.one", "a.two", "a.three"]);
    });

    it("caps pinned ids at 100", () => {
      for (let i = 0; i < 105; i++) {
        useActionPrefsStore.getState().pinAction(`a.action${i}`);
      }
      expect(useActionPrefsStore.getState().pinnedActionIds).toHaveLength(100);
    });
  });

  describe("unpinAction", () => {
    it("removes an id from pinnedActionIds", () => {
      useActionPrefsStore.getState().pinAction("a.one");
      useActionPrefsStore.getState().pinAction("a.two");
      useActionPrefsStore.getState().unpinAction("a.one");
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["a.two"]);
    });

    it("is idempotent — unpinning a non-pinned id is a no-op", () => {
      useActionPrefsStore.getState().pinAction("a.one");
      useActionPrefsStore.getState().unpinAction("a.unknown");
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["a.one"]);
    });
  });

  describe("hideAction", () => {
    it("adds an id to hiddenActionIds", () => {
      useActionPrefsStore.getState().hideAction("a.one");
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual(["a.one"]);
    });

    it("is idempotent", () => {
      useActionPrefsStore.getState().hideAction("a.one");
      useActionPrefsStore.getState().hideAction("a.one");
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual(["a.one"]);
    });

    it("caps hidden ids at 200", () => {
      for (let i = 0; i < 205; i++) {
        useActionPrefsStore.getState().hideAction(`a.action${i}`);
      }
      expect(useActionPrefsStore.getState().hiddenActionIds).toHaveLength(200);
    });
  });

  describe("showAction", () => {
    it("removes an id from hiddenActionIds (undo)", () => {
      useActionPrefsStore.getState().hideAction("a.one");
      useActionPrefsStore.getState().showAction("a.one");
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual([]);
    });
  });

  describe("resetHiddenActions", () => {
    it("clears all hidden ids", () => {
      useActionPrefsStore.getState().hideAction("a.one");
      useActionPrefsStore.getState().hideAction("a.two");
      useActionPrefsStore.getState().resetHiddenActions();
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual([]);
    });

    it("leaves pinned ids untouched", () => {
      useActionPrefsStore.getState().pinAction("a.pinned");
      useActionPrefsStore.getState().hideAction("a.hidden");
      useActionPrefsStore.getState().resetHiddenActions();
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["a.pinned"]);
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual([]);
    });
  });

  describe("hydrateActionPrefs", () => {
    it("replaces both lists", () => {
      useActionPrefsStore.getState().pinAction("stale.pin");
      useActionPrefsStore.getState().hideAction("stale.hide");
      useActionPrefsStore
        .getState()
        .hydrateActionPrefs({ pinnedIds: ["fresh.pin"], hiddenIds: ["fresh.hide"] });
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["fresh.pin"]);
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual(["fresh.hide"]);
    });

    it("dedupes input", () => {
      useActionPrefsStore
        .getState()
        .hydrateActionPrefs({ pinnedIds: ["a", "a", "b"], hiddenIds: ["x", "x", "y"] });
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual(["a", "b"]);
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual(["x", "y"]);
    });

    it("treats missing arrays as empty", () => {
      useActionPrefsStore.getState().pinAction("a.one");
      useActionPrefsStore.getState().hydrateActionPrefs({});
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual([]);
      expect(useActionPrefsStore.getState().hiddenActionIds).toEqual([]);
    });
  });

  describe("isActionPinned / isActionHidden", () => {
    it("reflects state", () => {
      useActionPrefsStore.getState().pinAction("a.pinned");
      useActionPrefsStore.getState().hideAction("a.hidden");
      expect(useActionPrefsStore.getState().isActionPinned("a.pinned")).toBe(true);
      expect(useActionPrefsStore.getState().isActionPinned("a.other")).toBe(false);
      expect(useActionPrefsStore.getState().isActionHidden("a.hidden")).toBe(true);
      expect(useActionPrefsStore.getState().isActionHidden("a.other")).toBe(false);
    });
  });
});
