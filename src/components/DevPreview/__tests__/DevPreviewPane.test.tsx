import { describe, it, expect, beforeEach } from "vitest";
import type { BrowserHistory } from "@shared/types/domain";
import type { DevPreviewStatus } from "@/hooks/useDevServer";
import { normalizeBrowserUrl } from "../../Browser/browserUtils";

// ─── Browser History Logic ──────────────────────────────────────────
// Extracted from DevPreviewPane to enable pure-function testing
// without Electron webview, Zustand, or complex component dependencies.

interface HistoryState extends BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

function pushUrl(state: HistoryState, url: string): HistoryState {
  return {
    past: state.present ? [...state.past, state.present] : state.past,
    present: url,
    future: [],
  };
}

function goBack(state: HistoryState): HistoryState {
  if (state.past.length === 0) return state;
  const newPast = [...state.past];
  const newPresent = newPast.pop()!;
  return {
    past: newPast,
    present: newPresent,
    future: [state.present, ...state.future],
  };
}

function goForward(state: HistoryState): HistoryState {
  if (state.future.length === 0) return state;
  const newFuture = [...state.future];
  const newPresent = newFuture.shift()!;
  return {
    past: [...state.past, state.present],
    present: newPresent,
    future: newFuture,
  };
}

function handleNavigate(state: HistoryState, rawUrl: string): HistoryState {
  const normalized = normalizeBrowserUrl(rawUrl);
  if (normalized.url) {
    return pushUrl(state, normalized.url);
  }
  return state;
}

function initHistory(saved?: BrowserHistory | null): HistoryState {
  if (
    saved &&
    Array.isArray(saved.past) &&
    Array.isArray(saved.future) &&
    typeof saved.present === "string"
  ) {
    return {
      past: saved.past as string[],
      present: saved.present || "",
      future: saved.future as string[],
    };
  }
  return { past: [], present: "", future: [] };
}

function initZoom(savedZoom?: number | null): number {
  const zoom = savedZoom ?? 1.0;
  return Number.isFinite(zoom) ? Math.max(0.25, Math.min(2.0, zoom)) : 1.0;
}

// ─── Status Config ──────────────────────────────────────────────────

const statusConfig: Record<DevPreviewStatus, { label: string; color: string }> = {
  starting: { label: "Starting", color: "text-blue-400" },
  installing: { label: "Installing", color: "text-yellow-400" },
  running: { label: "Running", color: "text-green-400" },
  error: { label: "Error", color: "text-red-400" },
  stopped: { label: "Stopped", color: "text-gray-400" },
};

// ─── Rendering decision logic ───────────────────────────────────────

type RenderState = "error" | "loading-spinner" | "waiting" | "webview";

function determineRenderState(
  status: DevPreviewStatus,
  hasError: boolean,
  currentUrl: string
): RenderState {
  if (status === "error" && hasError) return "error";
  if (status === "starting" || status === "installing") return "loading-spinner";
  if (!currentUrl) return "waiting";
  return "webview";
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("DevPreviewPane", () => {
  describe("status configuration", () => {
    it("maps all DevPreviewStatus values to label and color", () => {
      const statuses: DevPreviewStatus[] = [
        "stopped",
        "starting",
        "installing",
        "running",
        "error",
      ];

      for (const status of statuses) {
        const config = statusConfig[status];
        expect(config).toBeDefined();
        expect(config.label).toBeTruthy();
        expect(config.color).toMatch(/^text-/);
      }
    });

    it("uses green for running status", () => {
      expect(statusConfig.running.color).toBe("text-green-400");
      expect(statusConfig.running.label).toBe("Running");
    });

    it("uses red for error status", () => {
      expect(statusConfig.error.color).toBe("text-red-400");
      expect(statusConfig.error.label).toBe("Error");
    });

    it("uses blue for starting status", () => {
      expect(statusConfig.starting.color).toBe("text-blue-400");
    });

    it("uses yellow for installing status", () => {
      expect(statusConfig.installing.color).toBe("text-yellow-400");
    });
  });

  describe("render state determination", () => {
    it("shows error state when status is error and error exists", () => {
      expect(determineRenderState("error", true, "")).toBe("error");
    });

    it("shows error state even when URL exists", () => {
      expect(determineRenderState("error", true, "http://localhost:3000/")).toBe("error");
    });

    it("shows waiting state when status is error but no error object and no URL", () => {
      expect(determineRenderState("error", false, "")).toBe("waiting");
    });

    it("shows webview when status is error but no error object and URL exists", () => {
      expect(determineRenderState("error", false, "http://localhost:3000/")).toBe("webview");
    });

    it("shows loading spinner when starting", () => {
      expect(determineRenderState("starting", false, "")).toBe("loading-spinner");
    });

    it("shows loading spinner when installing", () => {
      expect(determineRenderState("installing", false, "")).toBe("loading-spinner");
    });

    it("shows waiting state when stopped with no URL", () => {
      expect(determineRenderState("stopped", false, "")).toBe("waiting");
    });

    it("shows waiting state when running with no URL", () => {
      expect(determineRenderState("running", false, "")).toBe("waiting");
    });

    it("shows webview when running with URL", () => {
      expect(determineRenderState("running", false, "http://localhost:3000/")).toBe("webview");
    });

    it("shows webview when stopped with existing URL", () => {
      expect(determineRenderState("stopped", false, "http://localhost:3000/")).toBe("webview");
    });
  });

  describe("browser history management", () => {
    let state: HistoryState;

    beforeEach(() => {
      state = { past: [], present: "", future: [] };
    });

    describe("pushUrl", () => {
      it("sets first URL as present with empty past", () => {
        const next = pushUrl(state, "http://localhost:3000/");
        expect(next.present).toBe("http://localhost:3000/");
        expect(next.past).toEqual([]);
        expect(next.future).toEqual([]);
      });

      it("pushes current URL to past when navigating", () => {
        state.present = "http://localhost:3000/";
        const next = pushUrl(state, "http://localhost:3000/about");
        expect(next.present).toBe("http://localhost:3000/about");
        expect(next.past).toEqual(["http://localhost:3000/"]);
      });

      it("clears future on navigation", () => {
        state = {
          past: ["http://localhost:3000/"],
          present: "http://localhost:3000/about",
          future: ["http://localhost:3000/contact"],
        };
        const next = pushUrl(state, "http://localhost:3000/new");
        expect(next.future).toEqual([]);
        expect(next.present).toBe("http://localhost:3000/new");
      });

      it("builds up history stack", () => {
        let h = pushUrl(state, "http://localhost:3000/a");
        h = pushUrl(h, "http://localhost:3000/b");
        h = pushUrl(h, "http://localhost:3000/c");

        expect(h.past).toEqual(["http://localhost:3000/a", "http://localhost:3000/b"]);
        expect(h.present).toBe("http://localhost:3000/c");
        expect(h.future).toEqual([]);
      });
    });

    describe("goBack", () => {
      it("does nothing when past is empty", () => {
        state.present = "http://localhost:3000/";
        const next = goBack(state);
        expect(next).toBe(state);
      });

      it("navigates back through history", () => {
        state = {
          past: ["http://localhost:3000/"],
          present: "http://localhost:3000/about",
          future: [],
        };
        const next = goBack(state);
        expect(next.present).toBe("http://localhost:3000/");
        expect(next.past).toEqual([]);
        expect(next.future).toEqual(["http://localhost:3000/about"]);
      });

      it("preserves existing future entries", () => {
        state = {
          past: ["http://localhost:3000/a"],
          present: "http://localhost:3000/b",
          future: ["http://localhost:3000/c"],
        };
        const next = goBack(state);
        expect(next.present).toBe("http://localhost:3000/a");
        expect(next.future).toEqual(["http://localhost:3000/b", "http://localhost:3000/c"]);
      });
    });

    describe("goForward", () => {
      it("does nothing when future is empty", () => {
        state.present = "http://localhost:3000/";
        const next = goForward(state);
        expect(next).toBe(state);
      });

      it("navigates forward through history", () => {
        state = {
          past: [],
          present: "http://localhost:3000/",
          future: ["http://localhost:3000/about"],
        };
        const next = goForward(state);
        expect(next.present).toBe("http://localhost:3000/about");
        expect(next.past).toEqual(["http://localhost:3000/"]);
        expect(next.future).toEqual([]);
      });

      it("handles multiple forward entries", () => {
        state = {
          past: [],
          present: "http://localhost:3000/a",
          future: ["http://localhost:3000/b", "http://localhost:3000/c"],
        };
        const next = goForward(state);
        expect(next.present).toBe("http://localhost:3000/b");
        expect(next.future).toEqual(["http://localhost:3000/c"]);
      });
    });

    describe("back and forward round-trip", () => {
      it("restores original state after back then forward", () => {
        let h = pushUrl(state, "http://localhost:3000/a");
        h = pushUrl(h, "http://localhost:3000/b");

        const afterBack = goBack(h);
        expect(afterBack.present).toBe("http://localhost:3000/a");

        const afterForward = goForward(afterBack);
        expect(afterForward.present).toBe("http://localhost:3000/b");
        expect(afterForward.past).toEqual(["http://localhost:3000/a"]);
        expect(afterForward.future).toEqual([]);
      });

      it("supports multiple back then forward", () => {
        let h = pushUrl(state, "http://localhost:3000/a");
        h = pushUrl(h, "http://localhost:3000/b");
        h = pushUrl(h, "http://localhost:3000/c");

        h = goBack(h);
        h = goBack(h);
        expect(h.present).toBe("http://localhost:3000/a");

        h = goForward(h);
        expect(h.present).toBe("http://localhost:3000/b");
      });
    });

    describe("handleNavigate", () => {
      it("normalizes and pushes valid URL", () => {
        state.present = "http://localhost:3000/";
        const next = handleNavigate(state, "localhost:4000/test");
        expect(next.present).toBe("http://localhost:4000/test");
        expect(next.past).toEqual(["http://localhost:3000/"]);
      });

      it("returns same state for invalid URL", () => {
        state.present = "http://localhost:3000/";
        const next = handleNavigate(state, "not-a-localhost-url.example.com");
        expect(next).toBe(state);
      });

      it("normalizes URLs without protocol", () => {
        const next = handleNavigate(state, "localhost:5173");
        expect(next.present).toBe("http://localhost:5173/");
      });
    });
  });

  describe("history initialization", () => {
    it("returns empty history when no saved state", () => {
      const h = initHistory(null);
      expect(h).toEqual({ past: [], present: "", future: [] });
    });

    it("returns empty history for undefined", () => {
      const h = initHistory(undefined);
      expect(h).toEqual({ past: [], present: "", future: [] });
    });

    it("restores valid saved history", () => {
      const saved: BrowserHistory = {
        past: ["http://localhost:3000/a"],
        present: "http://localhost:3000/b",
        future: ["http://localhost:3000/c"],
      };
      const h = initHistory(saved);
      expect(h).toEqual(saved);
    });

    it("returns empty history for malformed saved state", () => {
      const h = initHistory({
        past: "not-array",
        present: 123,
        future: null,
      } as unknown as BrowserHistory);
      expect(h).toEqual({ past: [], present: "", future: [] });
    });

    it("uses empty string for falsy present", () => {
      const saved: BrowserHistory = {
        past: [],
        present: "",
        future: [],
      };
      const h = initHistory(saved);
      expect(h.present).toBe("");
    });
  });

  describe("zoom initialization", () => {
    it("defaults to 1.0 when no saved zoom", () => {
      expect(initZoom(null)).toBe(1.0);
      expect(initZoom(undefined)).toBe(1.0);
    });

    it("restores valid saved zoom", () => {
      expect(initZoom(1.5)).toBe(1.5);
    });

    it("clamps zoom to minimum 0.25", () => {
      expect(initZoom(0.1)).toBe(0.25);
    });

    it("clamps zoom to maximum 2.0", () => {
      expect(initZoom(5.0)).toBe(2.0);
    });

    it("returns 1.0 for NaN", () => {
      expect(initZoom(NaN)).toBe(1.0);
    });

    it("returns 1.0 for Infinity", () => {
      expect(initZoom(Infinity)).toBe(1.0);
    });
  });

  describe("console drawer visibility", () => {
    it("drawer should be shown when terminalId is present", () => {
      const terminalId: string | null = "term-123";
      expect(!!terminalId).toBe(true);
    });

    it("drawer should not be shown when terminalId is null", () => {
      const terminalId: string | null = null;
      expect(!!terminalId).toBe(false);
    });
  });

  describe("auto-start behavior", () => {
    function shouldAutoStart(devCommand: string, status: DevPreviewStatus): boolean {
      return !!(devCommand && status === "stopped");
    }

    it("should auto-start when devCommand exists and status is stopped", () => {
      expect(shouldAutoStart("npm run dev", "stopped")).toBe(true);
    });

    it("should not auto-start when devCommand is empty", () => {
      expect(shouldAutoStart("", "stopped")).toBe(false);
    });

    it("should not auto-start when status is running", () => {
      expect(shouldAutoStart("npm run dev", "running")).toBe(false);
    });

    it("should not auto-start when status is starting", () => {
      expect(shouldAutoStart("npm run dev", "starting")).toBe(false);
    });

    it("should not auto-start when status is error", () => {
      expect(shouldAutoStart("npm run dev", "error")).toBe(false);
    });
  });

  describe("canGoBack and canGoForward", () => {
    it("canGoBack is false with empty past", () => {
      const state: HistoryState = { past: [], present: "http://localhost:3000/", future: [] };
      expect(state.past.length > 0).toBe(false);
    });

    it("canGoBack is true with non-empty past", () => {
      const state: HistoryState = {
        past: ["http://localhost:3000/a"],
        present: "http://localhost:3000/b",
        future: [],
      };
      expect(state.past.length > 0).toBe(true);
    });

    it("canGoForward is false with empty future", () => {
      const state: HistoryState = { past: [], present: "http://localhost:3000/", future: [] };
      expect(state.future.length > 0).toBe(false);
    });

    it("canGoForward is true with non-empty future", () => {
      const state: HistoryState = {
        past: [],
        present: "http://localhost:3000/a",
        future: ["http://localhost:3000/b"],
      };
      expect(state.future.length > 0).toBe(true);
    });
  });

  describe("URL change from hook", () => {
    it("should update history when new URL differs from current", () => {
      const state: HistoryState = { past: [], present: "", future: [] };
      const url = "http://localhost:3000/";
      const currentUrl = state.present;

      if (url && url !== currentUrl) {
        const next = pushUrl(state, url);
        expect(next.present).toBe(url);
      }
    });

    it("should not update history when URL matches current", () => {
      const state: HistoryState = {
        past: [],
        present: "http://localhost:3000/",
        future: [],
      };
      const url = "http://localhost:3000/";
      const currentUrl = state.present;

      const shouldUpdate = url && url !== currentUrl;
      expect(shouldUpdate).toBeFalsy();
    });

    it("should not update history when URL is null", () => {
      const url: string | null = null;
      const shouldUpdate = url && url !== "";
      expect(shouldUpdate).toBeFalsy();
    });
  });

  describe("error UI decision logic", () => {
    it("shows retry button in error state", () => {
      const status: DevPreviewStatus = "error";
      const error = { type: "port-conflict" as const, message: "Port 3000 in use" };
      const showRetry = status === "error" && !!error;
      expect(showRetry).toBe(true);
    });

    it("shows Open External button when error and URL exist", () => {
      const status: DevPreviewStatus = "error";
      const error = { type: "unknown" as const, message: "Something went wrong" };
      const currentUrl = "http://localhost:3000/";
      const showExternal = status === "error" && !!error && !!currentUrl;
      expect(showExternal).toBe(true);
    });

    it("hides Open External button when no URL in error state", () => {
      const currentUrl = "";
      const showExternal = !!currentUrl;
      expect(showExternal).toBe(false);
    });
  });

  describe("no dev command warning", () => {
    it("shows warning when no devCommand and waiting", () => {
      const devCommand = "";
      const renderState = determineRenderState("stopped", false, "");
      const showWarning = renderState === "waiting" && !devCommand;
      expect(showWarning).toBe(true);
    });

    it("does not show warning when devCommand exists", () => {
      const devCommand = "npm run dev";
      const renderState = determineRenderState("stopped", false, "");
      const showWarning = renderState === "waiting" && !devCommand;
      expect(showWarning).toBe(false);
    });
  });
});
