import { describe, expect, it } from "vitest";
import { formatErrorMessage, humanizeAppError } from "../errorMessage.js";
import type { ErrorRecord, ErrorType, GitOperationReason } from "../../types/ipc/errors.js";

describe("formatErrorMessage", () => {
  const FALLBACK = "Couldn't load thing";

  describe("Error instances", () => {
    it("returns the message of a real Error", () => {
      expect(formatErrorMessage(new Error("boom"), FALLBACK)).toBe("boom");
    });

    it("returns the message of a TypeError subclass", () => {
      expect(formatErrorMessage(new TypeError("bad type"), FALLBACK)).toBe("bad type");
    });

    it("returns the empty string for an Error with empty message (does NOT fall back)", () => {
      expect(formatErrorMessage(new Error(""), FALLBACK)).toBe("");
    });
  });

  describe("string errors", () => {
    it("returns the string as-is", () => {
      expect(formatErrorMessage("plain string error", FALLBACK)).toBe("plain string error");
    });

    it("returns the empty string when error is empty string", () => {
      expect(formatErrorMessage("", FALLBACK)).toBe("");
    });
  });

  describe("IPC duck-typed errors", () => {
    it("returns message from a plain { message: string } object (Electron IPC strip case)", () => {
      const ipcError = { message: "remote failure", name: "Error", stack: "..." };
      expect(formatErrorMessage(ipcError, FALLBACK)).toBe("remote failure");
    });

    it("falls back when message is a non-string", () => {
      expect(formatErrorMessage({ message: 42 }, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back when message is null", () => {
      expect(formatErrorMessage({ message: null }, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back when message is undefined", () => {
      expect(formatErrorMessage({ message: undefined }, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back when message is an object", () => {
      expect(formatErrorMessage({ message: { nested: "thing" } }, FALLBACK)).toBe(FALLBACK);
    });
  });

  describe("opaque values fall back", () => {
    it("falls back for null", () => {
      expect(formatErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back for undefined", () => {
      expect(formatErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back for a number", () => {
      expect(formatErrorMessage(42, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back for a boolean", () => {
      expect(formatErrorMessage(true, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back for an object without message", () => {
      expect(formatErrorMessage({ code: "EFAIL" }, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back for an array", () => {
      expect(formatErrorMessage(["error", "list"], FALLBACK)).toBe(FALLBACK);
    });

    it("falls back for a Symbol", () => {
      expect(formatErrorMessage(Symbol("err"), FALLBACK)).toBe(FALLBACK);
    });
  });

  describe("contract", () => {
    it("does not stringify opaque objects (no [object Object] leakage)", () => {
      expect(formatErrorMessage({ foo: "bar" }, FALLBACK)).not.toContain("[object Object]");
    });

    it("falls back when the message getter throws", () => {
      const hostile = {
        get message(): string {
          throw new Error("getter blew up");
        },
      };
      expect(formatErrorMessage(hostile, FALLBACK)).toBe(FALLBACK);
    });

    it("falls back when a Proxy has-trap throws", () => {
      const hostile = new Proxy(
        {},
        {
          has() {
            throw new Error("has-trap blew up");
          },
        }
      );
      expect(formatErrorMessage(hostile, FALLBACK)).toBe(FALLBACK);
    });
  });
});

describe("humanizeAppError", () => {
  type HumanizeInput = Pick<
    ErrorRecord,
    "type" | "source" | "message" | "gitReason" | "recoveryHint"
  >;

  const baseError = (overrides: Partial<HumanizeInput> = {}): HumanizeInput => ({
    type: "unknown",
    message: "raw library output",
    ...overrides,
  });

  describe("ErrorType fallbacks", () => {
    const cases: Array<[ErrorType, string]> = [
      ["git", "Git operation failed"],
      ["process", "Background process failed"],
      ["filesystem", "File operation failed"],
      ["network", "Network problem"],
      ["config", "Configuration problem"],
      ["unknown", "Something went wrong"],
    ];

    it.each(cases)("returns the %s fallback title and body", (type, expectedTitle) => {
      const result = humanizeAppError(baseError({ type }));
      expect(result.title).toBe(expectedTitle);
      expect(result.body.length).toBeGreaterThan(0);
    });

    it("falls through to 'unknown' for a runtime-unknown type value", () => {
      // Force-cast: structured-clone could in theory deliver a string outside
      // the union (older main + newer renderer, or vice versa).
      const result = humanizeAppError(
        baseError({ type: "totally-new-category" as unknown as ErrorType })
      );
      expect(result.title).toBe("Something went wrong");
    });

    it("never leaks raw error.message into the body", () => {
      const result = humanizeAppError(
        baseError({
          type: "filesystem",
          message: "EBUSY: resource busy or locked /Users/me/secret/path",
        })
      );
      expect(result.body).not.toContain("EBUSY");
      expect(result.body).not.toContain("/Users/me/secret/path");
    });

    it("never uses error.source as the title", () => {
      const result = humanizeAppError(baseError({ type: "process", source: "WorktreeMonitor" }));
      expect(result.title).not.toContain("WorktreeMonitor");
    });
  });

  describe("gitReason mapping", () => {
    const reasons: GitOperationReason[] = [
      "auth-failed",
      "network-unavailable",
      "repository-not-found",
      "not-a-repository",
      "dubious-ownership",
      "config-missing",
      "worktree-dirty",
      "conflict-unresolved",
      "push-rejected-outdated",
      "push-rejected-policy",
      "pathspec-invalid",
      "lfs-missing",
      "lfs-quota-exceeded",
      "hook-rejected",
      "system-io-error",
    ];

    it.each(reasons)("returns a friendly title and instruction body for %s", (reason) => {
      const result = humanizeAppError(baseError({ type: "git", gitReason: reason }));
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.title).not.toBe("Git operation failed");
      expect(result.body.length).toBeGreaterThan(0);
    });

    it("uses generic git fallback when gitReason is 'unknown'", () => {
      const result = humanizeAppError(baseError({ type: "git", gitReason: "unknown" }));
      expect(result.title).toBe("Git operation failed");
    });

    it("uses generic git fallback when gitReason is undefined", () => {
      const result = humanizeAppError(baseError({ type: "git" }));
      expect(result.title).toBe("Git operation failed");
    });

    it("falls back to generic git title when gitReason is an out-of-union string (version skew)", () => {
      // Older renderer + newer main process can deliver a future reason code
      // not yet known to the renderer. The `satisfies` check is compile-time
      // only; the runtime lookup must still produce a real title.
      const result = humanizeAppError(
        baseError({
          type: "git",
          gitReason: "future-reason-2027" as unknown as GitOperationReason,
        })
      );
      expect(result.title).toBe("Git operation failed");
      expect(result.body.length).toBeGreaterThan(0);
    });

    it("specific git body matches the recovery hint copy", () => {
      const result = humanizeAppError(baseError({ type: "git", gitReason: "auth-failed" }));
      expect(result.title).toBe("Git authentication failed");
      expect(result.body).toBe("Check your Git credentials or SSH key configuration.");
    });
  });

  describe("recoveryHint integration", () => {
    it("uses recoveryHint as the body when no gitReason mapping wins", () => {
      const result = humanizeAppError(
        baseError({
          type: "filesystem",
          recoveryHint: "Free up disk space and retry the operation.",
        })
      );
      expect(result.title).toBe("File operation failed");
      expect(result.body).toBe("Free up disk space and retry the operation.");
    });

    it("ignores empty recoveryHint and keeps the type fallback body", () => {
      const result = humanizeAppError(baseError({ type: "config", recoveryHint: "" }));
      expect(result.body).toBe("Daintree found a problem with the current configuration.");
    });

    it("gitReason wins over recoveryHint when both are present", () => {
      const result = humanizeAppError(
        baseError({
          type: "git",
          gitReason: "auth-failed",
          recoveryHint: "Should be ignored.",
        })
      );
      expect(result.body).toBe("Check your Git credentials or SSH key configuration.");
    });
  });
});
