import { describe, expect, it } from "vitest";
import type { BrowserHistory } from "@shared/types/browser";
import {
  goBackBrowserHistory,
  goForwardBrowserHistory,
  initializeBrowserHistory,
  MAX_BROWSER_HISTORY_ENTRIES,
  pushBrowserHistory,
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
});
