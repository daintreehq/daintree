// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useErrorStore } from "@/store/errorStore";

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logDebug, logWarn, logError } from "@/utils/logger";
import { onCaughtError, onUncaughtError, onRecoverableError } from "../reactRootErrorCallbacks";

const mockedLogDebug = vi.mocked(logDebug);
const mockedLogWarn = vi.mocked(logWarn);
const mockedLogError = vi.mocked(logError);

describe("reactRootErrorCallbacks", () => {
  const componentStack = "\n    at BrokenComponent\n    at App";

  beforeEach(() => {
    useErrorStore.getState().reset();
    mockedLogDebug.mockReset();
    mockedLogWarn.mockReset();
    mockedLogError.mockReset();
  });

  describe("onCaughtError", () => {
    it("logs a warning with error message and componentStack", () => {
      const error = new Error("boundary caught this");
      onCaughtError(error, { componentStack });

      expect(mockedLogWarn).toHaveBeenCalledOnce();
      expect(mockedLogWarn).toHaveBeenCalledWith("[React] Caught render error", {
        error: "boundary caught this",
        componentStack,
      });
    });

    it("does NOT add to the error store", () => {
      onCaughtError(new Error("caught"), { componentStack });
      expect(useErrorStore.getState().errors).toHaveLength(0);
    });

    it("handles non-Error values", () => {
      onCaughtError("string error", { componentStack });
      expect(mockedLogWarn).toHaveBeenCalledWith("[React] Caught render error", {
        error: "string error",
        componentStack,
      });
    });

    it("handles undefined componentStack", () => {
      onCaughtError(new Error("no stack"), {});
      expect(mockedLogWarn).toHaveBeenCalledWith("[React] Caught render error", {
        error: "no stack",
        componentStack: undefined,
      });
    });

    it("does not throw when logger fails", () => {
      mockedLogWarn.mockImplementation(() => {
        throw new Error("logger broken");
      });
      expect(() => onCaughtError(new Error("test"), { componentStack })).not.toThrow();
    });
  });

  describe("onUncaughtError", () => {
    it("adds error to store and logs with logError", () => {
      const error = new Error("fatal render crash");
      onUncaughtError(error, { componentStack });

      const errors = useErrorStore.getState().errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        type: "unknown",
        message: "fatal render crash",
        details: componentStack,
        source: "React Uncaught Render Error",
        isTransient: false,
      });

      expect(mockedLogError).toHaveBeenCalledOnce();
      expect(mockedLogError).toHaveBeenCalledWith("[React] Uncaught render error", error, {
        componentStack,
      });
    });

    it("handles non-Error values via getErrorMessage", () => {
      onUncaughtError("string error", { componentStack });

      const errors = useErrorStore.getState().errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("string error");
    });

    it("handles null error", () => {
      onUncaughtError(null, { componentStack });

      const errors = useErrorStore.getState().errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("null");
    });

    it("still logs even if store throws", () => {
      const addError = vi.spyOn(useErrorStore.getState(), "addError").mockImplementation(() => {
        throw new Error("store broken");
      });
      const error = new Error("render crash");

      expect(() => onUncaughtError(error, { componentStack })).not.toThrow();
      expect(mockedLogError).toHaveBeenCalledOnce();

      addError.mockRestore();
    });

    it("still adds to store even if logger throws", () => {
      mockedLogError.mockImplementation(() => {
        throw new Error("logger broken");
      });
      const error = new Error("render crash");

      expect(() => onUncaughtError(error, { componentStack })).not.toThrow();
      expect(useErrorStore.getState().errors).toHaveLength(1);
    });
  });

  describe("onRecoverableError", () => {
    it("logs at debug level only", () => {
      const error = new Error("hydration mismatch");
      onRecoverableError(error, { componentStack });

      expect(mockedLogDebug).toHaveBeenCalledOnce();
      expect(mockedLogDebug).toHaveBeenCalledWith("[React] Recoverable render error", {
        error: "hydration mismatch",
        componentStack,
      });
    });

    it("does NOT add to error store", () => {
      onRecoverableError(new Error("recovered"), { componentStack });
      expect(useErrorStore.getState().errors).toHaveLength(0);
    });

    it("does NOT call logWarn or logError", () => {
      onRecoverableError(new Error("recovered"), { componentStack });
      expect(mockedLogWarn).not.toHaveBeenCalled();
      expect(mockedLogError).not.toHaveBeenCalled();
    });

    it("does not throw when logger fails", () => {
      mockedLogDebug.mockImplementation(() => {
        throw new Error("logger broken");
      });
      expect(() => onRecoverableError(new Error("test"), { componentStack })).not.toThrow();
    });
  });
});
