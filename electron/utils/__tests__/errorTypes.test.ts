import { describe, it, expect } from "vitest";
import {
  AppError,
  GitError,
  GitOperationError,
  WorktreeRemovedError,
  DaintreeError,
  isAppError,
  toGitOperationError,
  getUserMessage,
  getRetryability,
  getErrorDetails,
} from "../errorTypes.js";
import { serializeError, deserializeError } from "../../../shared/utils/ipcErrorSerialization.js";

describe("GitOperationError", () => {
  it("preserves the GitError -> DaintreeError -> Error hierarchy", () => {
    const err = new GitOperationError("auth-failed", "boom", { cwd: "/repo", op: "push" });
    expect(err).toBeInstanceOf(GitOperationError);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toBeInstanceOf(DaintreeError);
    expect(err).toBeInstanceOf(Error);
  });

  it("still allows existing WorktreeRemovedError instanceof checks to hold", () => {
    const wt = new WorktreeRemovedError("/missing");
    expect(wt).toBeInstanceOf(GitError);
    expect(wt).toBeInstanceOf(WorktreeRemovedError);
    // WorktreeRemovedError must NOT be conflated with the new taxonomy
    expect(wt).not.toBeInstanceOf(GitOperationError);
  });

  it("stamps reason/op/cwd into context and dedicated fields", () => {
    const err = new GitOperationError("conflict-unresolved", "merge conflict", {
      cwd: "/w",
      op: "merge",
    });
    expect(err.reason).toBe("conflict-unresolved");
    expect(err.op).toBe("merge");
    expect(err.context).toEqual(
      expect.objectContaining({
        cwd: "/w",
        op: "merge",
        reason: "conflict-unresolved",
      })
    );
  });

  it("defaults rawMessage to the visible message when unset", () => {
    const err = new GitOperationError("unknown", "hi");
    expect(err.rawMessage).toBe("hi");
  });
});

describe("toGitOperationError", () => {
  it("wraps a plain Error and classifies its reason", () => {
    const original = new Error("fatal: not a git repository");
    const wrapped = toGitOperationError(original, { cwd: "/x", op: "status" });
    expect(wrapped).toBeInstanceOf(GitOperationError);
    expect(wrapped.reason).toBe("not-a-repository");
    expect(wrapped.op).toBe("status");
    expect(wrapped.cause).toBe(original);
  });

  it("is idempotent — returns the same instance when given a GitOperationError", () => {
    const existing = new GitOperationError("auth-failed", "whoops", { op: "push" });
    const result = toGitOperationError(existing, { cwd: "/y", op: "clone" });
    expect(result).toBe(existing);
    // Never rewrites the original's op/cwd/reason
    expect(result.reason).toBe("auth-failed");
    expect(result.op).toBe("push");
  });

  it("coerces non-Error throwables without losing classification", () => {
    const wrapped = toGitOperationError("fatal: unable to read config file '/etc/gitconfig'");
    expect(wrapped).toBeInstanceOf(GitOperationError);
    expect(wrapped.reason).toBe("config-missing");
  });
});

describe("AppError", () => {
  it("preserves the AppError -> DaintreeError -> Error hierarchy", () => {
    const err = new AppError({ code: "BINARY_FILE", message: "binary" });
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(DaintreeError);
    expect(err).toBeInstanceOf(Error);
  });

  it("sets name to 'AppError' so renderer-side duck-typing works after IPC", () => {
    const err = new AppError({ code: "VALIDATION", message: "bad input" });
    expect(err.name).toBe("AppError");
  });

  it("stamps code and userMessage onto own properties", () => {
    const err = new AppError({
      code: "FILE_TOO_LARGE",
      message: "exceeds limit",
      userMessage: "This file is too large to preview.",
      context: { size: 600 * 1024, limit: 512 * 1024 },
    });
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.userMessage).toBe("This file is too large to preview.");
    expect(err.context).toEqual({ size: 600 * 1024, limit: 512 * 1024 });
  });

  it("exposes isAppError narrowing", () => {
    expect(isAppError(new AppError({ code: "CANCELLED", message: "cancel" }))).toBe(true);
    expect(isAppError(new GitError("git error"))).toBe(false);
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it("survives the serialize → structuredClone → deserialize cycle with code preserved", () => {
    const original = new AppError({
      code: "RATE_LIMITED",
      message: "Too many requests",
      userMessage: "Slow down — try again in a moment.",
    });

    const serialized = serializeError(original);
    expect(serialized.name).toBe("AppError");
    expect(serialized.code).toBe("RATE_LIMITED");
    expect(serialized.userMessage).toBe("Slow down — try again in a moment.");

    const restored = deserializeError(structuredClone(serialized)) as Error & {
      code: string;
      userMessage?: string;
    };
    expect(restored.name).toBe("AppError");
    expect(restored.message).toBe("Too many requests");
    expect(restored.code).toBe("RATE_LIMITED");
    expect(restored.userMessage).toBe("Slow down — try again in a moment.");
  });
});

describe("getUserMessage", () => {
  it("returns the Daintree error's own message when given a DaintreeError", () => {
    const err = new GitOperationError("auth-failed", "permission denied", { op: "push" });
    expect(getUserMessage(err)).toBe("permission denied");
  });

  it("returns the message of a plain Error", () => {
    expect(getUserMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a string error verbatim", () => {
    expect(getUserMessage("plain string")).toBe("plain string");
  });

  it("duck-types IPC-stripped error objects (Electron structured clone case)", () => {
    expect(getUserMessage({ message: "remote failure", name: "Error" })).toBe("remote failure");
  });

  it("falls back to 'An unknown error occurred' for opaque values", () => {
    expect(getUserMessage(42)).toBe("An unknown error occurred");
    expect(getUserMessage(null)).toBe("An unknown error occurred");
    expect(getUserMessage(undefined)).toBe("An unknown error occurred");
    expect(getUserMessage({ code: "EFAIL" })).toBe("An unknown error occurred");
  });

  it("prefers AppError.userMessage over message when present", () => {
    const err = new AppError({
      code: "BINARY_FILE",
      message: "Binary file cannot be displayed as text",
      userMessage: "This file can't be previewed.",
    });
    expect(getUserMessage(err)).toBe("This file can't be previewed.");
  });

  it("falls back to AppError.message when userMessage is absent", () => {
    const err = new AppError({ code: "VALIDATION", message: "Invalid payload" });
    expect(getUserMessage(err)).toBe("Invalid payload");
  });
});

describe("getRetryability", () => {
  it("classifies transient errno codes as 'auto'", () => {
    for (const code of ["EBUSY", "EAGAIN", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"]) {
      const err = Object.assign(new Error("net"), { code });
      expect(getRetryability(err)).toBe("auto");
    }
  });

  it("classifies non-transient errno codes as 'none'", () => {
    for (const code of ["ENOENT", "EACCES", "EMFILE", "ENOMEM", "ENXIO"]) {
      const err = Object.assign(new Error("permanent"), { code });
      expect(getRetryability(err)).toBe("none");
    }
  });

  it("maps git auth/config reasons to 'user-gated'", () => {
    for (const reason of [
      "auth-failed",
      "config-missing",
      "dubious-ownership",
      // Auto-retrying a machine with no Git installed just spins.
      "git-not-installed",
    ] as const) {
      const err = new GitOperationError(reason, "boom");
      expect(getRetryability(err)).toBe("user-gated");
    }
  });

  it("maps git transient reasons to 'auto'", () => {
    for (const reason of ["network-unavailable", "system-io-error"] as const) {
      const err = new GitOperationError(reason, "boom");
      expect(getRetryability(err)).toBe("auto");
    }
  });

  it("maps git terminal-policy reasons to 'none'", () => {
    for (const reason of [
      "repository-not-found",
      "not-a-repository",
      "worktree-dirty",
      "conflict-unresolved",
      "push-rejected-outdated",
      "push-rejected-policy",
      "pathspec-invalid",
      "lfs-missing",
      "lfs-quota-exceeded",
      "hook-rejected",
    ] as const) {
      const err = new GitOperationError(reason, "boom");
      expect(getRetryability(err)).toBe("none");
    }
  });

  it("falls through to errno when gitReason is 'unknown'", () => {
    const err = new GitOperationError("unknown", "boom");
    Object.assign(err, { code: "ETIMEDOUT" });
    expect(getRetryability(err)).toBe("auto");
  });

  it("prefers explicit gitReason argument over instance reason", () => {
    const err = new GitOperationError("auth-failed", "boom");
    expect(getRetryability(err, "network-unavailable")).toBe("auto");
  });

  it("returns 'none' for unknown shapes", () => {
    expect(getRetryability(null)).toBe("none");
    expect(getRetryability(undefined)).toBe("none");
    expect(getRetryability(new Error("plain"))).toBe("none");
  });
});

describe("getErrorDetails", () => {
  it("captures name, message and stack from a real Error", () => {
    const err = new TypeError("boom");
    const details = getErrorDetails(err);
    expect(details.name).toBe(err.name);
    expect(details.message).toBe(err.message);
    expect(details.stack).toBe(err.stack);
  });

  it("keeps name and stack from an error already flattened for IPC", () => {
    // What `dispatchRendererLog` hands us: the contextBridge strips the Error
    // prototype, so the value fails `instanceof Error` but still carries the
    // fields worth logging.
    const flattened = {
      name: "TypeError",
      message: "renderer failure",
      stack: "TypeError: renderer failure\n    at Component",
    };
    expect(flattened).not.toBeInstanceOf(Error);

    const details = getErrorDetails(flattened);
    expect(details.name).toBe(flattened.name);
    expect(details.message).toBe(flattened.message);
    expect(details.stack).toBe(flattened.stack);
  });

  it("ignores non-string name and stack values", () => {
    const details = getErrorDetails({ message: "m", name: 42, stack: { frames: [] } });
    expect(details.name).toBeUndefined();
    expect(details.stack).toBeUndefined();
  });

  it("does not treat a primitive as carrying error fields", () => {
    const details = getErrorDetails("just a string");
    expect(details.message).toBe("just a string");
    expect(details.name).toBeUndefined();
    expect(details.stack).toBeUndefined();
  });

  it("forwards the diagnostics a serialized error arrived with", () => {
    const serialized = serializeError(
      new GitOperationError("push-rejected-outdated", "push rejected", { command: "git push" })
    );
    // Simulate the IPC hop: only own-enumerable properties survive it.
    const overWire = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;

    const details = getErrorDetails(overWire);
    expect(details.gitReason).toBe(serialized.gitReason);
    expect(details.context).toEqual(serialized.context);
  });

  it("does not let a throwing accessor escape", () => {
    const hostile = {
      message: "original failure",
      get name(): string {
        throw new Error("name trap");
      },
    };

    let details: Record<string, unknown> = {};
    expect(() => {
      details = getErrorDetails(hostile);
    }).not.toThrow();
    expect(details.message).toBe("original failure");
    expect(details.name).toBeUndefined();
  });

  it("carries the cause of a plain Error, which is non-enumerable", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    expect(Object.keys(err)).not.toContain("cause");

    const details = getErrorDetails(err);
    expect((details.cause as Error).message).toBe("inner");
  });
});
