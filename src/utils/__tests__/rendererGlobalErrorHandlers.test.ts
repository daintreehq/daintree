// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useErrorStore } from "@/store/errorStore";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

import { logError } from "@/utils/logger";
import { registerRendererGlobalErrorHandlers } from "../rendererGlobalErrorHandlers";

const mockedLogError = vi.mocked(logError);

describe("rendererGlobalErrorHandlers", () => {
  let cleanup: () => void;

  beforeEach(() => {
    useErrorStore.getState().reset();
    mockedLogError.mockReset();
    cleanup = registerRendererGlobalErrorHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  describe("unhandledrejection", () => {
    it("creates an error store entry and logs for Error rejection", () => {
      const error = new Error("async failure");
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: error,
        promise: Promise.reject(error),
      });
      // Suppress the actual unhandled rejection from the test-created promise
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      const errors = useErrorStore.getState().errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("async failure");
      expect(errors[0]?.source).toBe("Renderer Promise Rejection");
      expect(errors[0]?.type).toBe("unknown");
      expect(errors[0]?.correlationId).toBeDefined();

      expect(mockedLogError).toHaveBeenCalledTimes(1);
      expect(mockedLogError).toHaveBeenCalledWith(
        expect.stringContaining("async failure"),
        error,
        expect.objectContaining({ kind: "unhandledrejection" })
      );
    });

    it("creates an error store entry for string rejection", () => {
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: "string rejection",
        promise: Promise.reject("string rejection"),
      });
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      const errors = useErrorStore.getState().errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("string rejection");
    });

    it("uses fallback message for undefined rejection reason", () => {
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: undefined,
        promise: Promise.reject(undefined),
      });
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      const errors = useErrorStore.getState().errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("Unhandled promise rejection (no reason)");
    });

    it("ignores AbortError rejections (DOMException)", () => {
      const error = new DOMException("Aborted", "AbortError");
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: error,
        promise: Promise.reject(error),
      });
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      expect(useErrorStore.getState().errors).toHaveLength(0);
      expect(mockedLogError).not.toHaveBeenCalled();
    });

    it("ignores AbortError rejections (Error with name)", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: error,
        promise: Promise.reject(error),
      });
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      expect(useErrorStore.getState().errors).toHaveLength(0);
    });
  });

  describe("error", () => {
    it("creates an error store entry with location metadata", () => {
      const error = new Error("sync failure");
      const event = new ErrorEvent("error", {
        error,
        message: "Uncaught Error: sync failure",
        filename: "http://localhost:5173/src/App.tsx",
        lineno: 42,
        colno: 10,
      });

      window.dispatchEvent(event);

      const errors = useErrorStore.getState().errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("Uncaught Error: sync failure");
      expect(errors[0]?.source).toBe("Renderer Error");
      expect(errors[0]?.details).toContain("http://localhost:5173/src/App.tsx:42:10");
      expect(errors[0]?.context?.filePath).toBe("http://localhost:5173/src/App.tsx");
    });

    it("ignores error events with no error and no message", () => {
      const event = new ErrorEvent("error", {});

      window.dispatchEvent(event);

      expect(useErrorStore.getState().errors).toHaveLength(0);
    });
  });

  describe("idempotency and cleanup", () => {
    it("does not double-register listeners on repeated calls", () => {
      const cleanup2 = registerRendererGlobalErrorHandlers();

      const error = new Error("test");
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: error,
        promise: Promise.reject(error),
      });
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      expect(useErrorStore.getState().errors).toHaveLength(1);
      cleanup2();
    });

    it("cleanup removes listeners", () => {
      cleanup();

      const error = new Error("after cleanup");
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: error,
        promise: Promise.reject(error),
      });
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      expect(useErrorStore.getState().errors).toHaveLength(0);

      // Re-register so afterEach cleanup doesn't fail
      cleanup = registerRendererGlobalErrorHandlers();
    });
  });

  describe("re-entrancy protection", () => {
    it("falls back to console.error if logError throws", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedLogError.mockImplementation(() => {
        throw new Error("logger broken");
      });

      const error = new Error("trigger");
      const event = new PromiseRejectionEvent("unhandledrejection", {
        reason: error,
        promise: Promise.reject(error),
      });
      event.promise.catch(() => {});

      window.dispatchEvent(event);

      // Error should still be in store (addError runs before logError)
      expect(useErrorStore.getState().errors).toHaveLength(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to log unhandledrejection"),
        error
      );

      consoleErrorSpy.mockRestore();
    });
  });
});
