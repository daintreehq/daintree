import { describe, expect, it } from "vitest";
import type { BrowserHistory } from "@shared/types/browser";
import {
  followGuestCommit,
  goBackBrowserHistory,
  goForwardBrowserHistory,
  initializeBrowserHistory,
  MAX_BROWSER_HISTORY_ENTRIES,
  pushBrowserHistory,
  stepBrowserHistory,
} from "../historyUtils";

describe("historyUtils", () => {
  describe("initializeBrowserHistory", () => {
    it("returns fallback state when saved history is missing", () => {
      expect(initializeBrowserHistory(undefined, "http://localhost:3000/")).toEqual({
        past: [],
        present: "http://localhost:3000/",
        future: [],
      });
    });

    it("restores and trims oversized saved history", () => {
      const past = Array.from({ length: MAX_BROWSER_HISTORY_ENTRIES + 5 }, (_, i) => `past-${i}`);
      const future = Array.from(
        { length: MAX_BROWSER_HISTORY_ENTRIES + 7 },
        (_, i) => `future-${i}`
      );
      const restored = initializeBrowserHistory(
        {
          past,
          present: "http://localhost:5173/",
          future,
        } satisfies BrowserHistory,
        ""
      );

      expect(restored.past).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES);
      expect(restored.past[0]).toBe("past-5");
      expect(restored.future).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES);
      expect(restored.future[0]).toBe("future-0");
    });
  });

  describe("pushBrowserHistory", () => {
    it("adds the previous page to past and clears future", () => {
      const next = pushBrowserHistory(
        {
          past: ["http://localhost:3000/"],
          present: "http://localhost:3000/about",
          future: ["http://localhost:3000/contact"],
        },
        "http://localhost:3000/docs"
      );

      expect(next).toEqual({
        past: ["http://localhost:3000/", "http://localhost:3000/about"],
        present: "http://localhost:3000/docs",
        future: [],
      });
    });

    it("returns the same object when navigating to the current URL", () => {
      const state: BrowserHistory = {
        past: ["http://localhost:3000/"],
        present: "http://localhost:3000/about",
        future: [],
      };

      expect(pushBrowserHistory(state, "http://localhost:3000/about")).toBe(state);
    });

    it("keeps only the newest past entries when history is oversized", () => {
      const past = Array.from({ length: MAX_BROWSER_HISTORY_ENTRIES }, (_, i) => `past-${i}`);
      const next = pushBrowserHistory(
        {
          past,
          present: "http://localhost:3000/current",
          future: [],
        },
        "http://localhost:3000/next"
      );

      expect(next.past).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES);
      expect(next.past[0]).toBe("past-1");
      expect(next.past[next.past.length - 1]).toBe("http://localhost:3000/current");
    });
  });

  describe("goBackBrowserHistory", () => {
    it("moves current page to future and returns previous past entry", () => {
      const next = goBackBrowserHistory({
        past: ["http://localhost:3000/", "http://localhost:3000/about"],
        present: "http://localhost:3000/docs",
        future: [],
      });

      expect(next).toEqual({
        past: ["http://localhost:3000/"],
        present: "http://localhost:3000/about",
        future: ["http://localhost:3000/docs"],
      });
    });
  });

  describe("goForwardBrowserHistory", () => {
    it("moves current page to past and advances to next future entry", () => {
      const next = goForwardBrowserHistory({
        past: ["http://localhost:3000/"],
        present: "http://localhost:3000/about",
        future: ["http://localhost:3000/docs", "http://localhost:3000/blog"],
      });

      expect(next).toEqual({
        past: ["http://localhost:3000/", "http://localhost:3000/about"],
        present: "http://localhost:3000/docs",
        future: ["http://localhost:3000/blog"],
      });
    });
  });

  describe("stepBrowserHistory", () => {
    const history: BrowserHistory = { past: ["/a", "/b"], present: "/c", future: ["/d", "/e"] };

    it("moves several entries either way", () => {
      expect(stepBrowserHistory(history, -2)).toEqual({
        past: [],
        present: "/a",
        future: ["/b", "/c", "/d", "/e"],
      });
      expect(stepBrowserHistory(history, 2)).toEqual({
        past: ["/a", "/b", "/c", "/d"],
        present: "/e",
        future: [],
      });
    });

    it("refuses a step off either end, or no step at all", () => {
      expect(stepBrowserHistory(history, -3)).toBe(history);
      expect(stepBrowserHistory(history, 3)).toBe(history);
      expect(stepBrowserHistory(history, 0)).toBe(history);
      expect(stepBrowserHistory(history, 0.5)).toBe(history);
      expect(stepBrowserHistory(history, Number.NaN)).toBe(history);
    });
  });

  describe("followGuestCommit", () => {
    const history: BrowserHistory = { past: ["/a", "/b"], present: "/c", future: ["/d", "/e"] };

    it("takes the step the host asked for while it lands on the committed URL", () => {
      expect(followGuestCommit(history, "/b", { offset: -1, traversed: true }).present).toBe("/b");
      // Between two entries for one URL: the guest moved even though the URL didn't.
      const repeated: BrowserHistory = { past: ["/x", "/y"], present: "/x", future: [] };
      expect(followGuestCommit(repeated, "/x", { offset: -2, traversed: true })).toEqual({
        past: [],
        present: "/x",
        future: ["/y", "/x"],
      });
      const stepped = followGuestCommit(
        { past: ["/x", "/y", "/x"], present: "/z", future: [] },
        "/x",
        { offset: -3, traversed: true }
      );
      expect(stepped).toEqual({ past: [], present: "/x", future: ["/y", "/x", "/z"] });
    });

    it("ignores a requested step that lands elsewhere", () => {
      expect(followGuestCommit(history, "/new", { offset: -1, traversed: false })).toEqual({
        past: ["/a", "/b", "/c"],
        present: "/new",
        future: [],
      });
    });

    it("finds a traversal the guest made on its own, nearest first", () => {
      expect(followGuestCommit(history, "/a", { traversed: true })).toEqual({
        past: [],
        present: "/a",
        future: ["/b", "/c", "/d", "/e"],
      });
      expect(followGuestCommit(history, "/d", { traversed: true })).toEqual({
        past: ["/a", "/b", "/c"],
        present: "/d",
        future: ["/e"],
      });
      // A nearer duplicate wins over the oldest one.
      const duplicated: BrowserHistory = { past: ["/x", "/y", "/x"], present: "/z", future: [] };
      expect(followGuestCommit(duplicated, "/x", { traversed: true })).toEqual({
        past: ["/x", "/y"],
        present: "/x",
        future: ["/z"],
      });
      // Equally far either way: history.back() is the likelier call.
      const tie: BrowserHistory = { past: ["/x"], present: "/y", future: ["/x", "/z"] };
      expect(followGuestCommit(tie, "/x", { traversed: true }).future).toEqual(["/y", "/x", "/z"]);
    });

    it("pushes a fresh entry, dropping everything ahead", () => {
      expect(followGuestCommit(history, "/new", { traversed: false })).toEqual({
        past: ["/a", "/b", "/c"],
        present: "/new",
        future: [],
      });
      // A fresh entry for a URL already behind is still a fresh entry.
      const revisited: BrowserHistory = { past: ["/root"], present: "/a", future: [] };
      expect(followGuestCommit(revisited, "/root", { traversed: false })).toEqual({
        past: ["/root", "/a"],
        present: "/root",
        future: [],
      });
      // A traversal to somewhere this history never saw is recorded as an entry too.
      expect(followGuestCommit(history, "/unknown", { traversed: true }).present).toBe("/unknown");
    });

    it("runs to the end of the history when the guest has nothing left ahead", () => {
      expect(followGuestCommit(history, "/e", { traversed: false })).toEqual({
        past: ["/a", "/b", "/c", "/d"],
        present: "/e",
        future: [],
      });
    });

    it("leaves the history alone for the entry already showing", () => {
      expect(followGuestCommit(history, "/c", { offset: 1, traversed: true })).toBe(history);
      expect(followGuestCommit(history, "/c", { traversed: false })).toBe(history);
      expect(followGuestCommit(history, "  ", { traversed: false })).toBe(history);
    });
  });
});
