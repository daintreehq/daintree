import { describe, expect, it } from "vitest";
import { classifyError, isTransientError, getErrorMessage } from "../errorContext";

/** Helper: create an error-like object with structured properties */
function makeError(
  message: string,
  props?: { name?: string; code?: string; syscall?: string }
): Error & Record<string, unknown> {
  const err = new Error(message) as Error & Record<string, unknown>;
  if (props?.name) err.name = props.name;
  if (props?.code) err.code = props.code;
  if (props?.syscall) err.syscall = props.syscall;
  return err;
}

describe("classifyError", () => {
  describe("tier 1: error.name (Canopy error classes)", () => {
    it("classifies GitError by name regardless of message", () => {
      expect(classifyError(makeError("fetch something", { name: "GitError" }))).toBe("git");
    });

    it("classifies WorktreeRemovedError as git", () => {
      expect(classifyError(makeError("directory removed", { name: "WorktreeRemovedError" }))).toBe(
        "git"
      );
    });

    it("classifies FileSystemError by name even with misleading message", () => {
      expect(classifyError(makeError("network timeout", { name: "FileSystemError" }))).toBe(
        "filesystem"
      );
    });

    it("classifies ProcessError by name", () => {
      expect(classifyError(makeError("something", { name: "ProcessError" }))).toBe("process");
    });

    it("classifies WatcherError as process", () => {
      expect(classifyError(makeError("something", { name: "WatcherError" }))).toBe("process");
    });

    it("classifies ConfigError as validation", () => {
      expect(classifyError(makeError("something", { name: "ConfigError" }))).toBe("validation");
    });

    it("does not match plain Error name", () => {
      // name="Error" should fall through to message matching
      expect(classifyError(new Error("git branch list"))).toBe("git");
    });

    it("does not match unknown custom error names", () => {
      expect(classifyError(makeError("something", { name: "MyCustomError" }))).toBe("unknown");
    });
  });

  describe("tier 2: error.code (POSIX codes)", () => {
    it("classifies ENOENT as filesystem even with misleading message", () => {
      expect(classifyError(makeError("fetch failed", { code: "ENOENT" }))).toBe("filesystem");
    });

    it("classifies ECONNREFUSED as network even with git message", () => {
      expect(classifyError(makeError("git operation", { code: "ECONNREFUSED" }))).toBe("network");
    });

    it("classifies EACCES as filesystem", () => {
      expect(classifyError(makeError("spawn terminal", { code: "EACCES" }))).toBe("filesystem");
    });

    it("classifies ETIMEDOUT as network", () => {
      expect(classifyError(makeError("something", { code: "ETIMEDOUT" }))).toBe("network");
    });

    it("classifies EBUSY as filesystem", () => {
      expect(classifyError(makeError("file is busy", { code: "EBUSY" }))).toBe("filesystem");
    });

    it("classifies EADDRINUSE as network", () => {
      expect(classifyError(makeError("something", { code: "EADDRINUSE" }))).toBe("network");
    });
  });

  describe("tier 3: error.syscall", () => {
    it("classifies spawn syscall as process", () => {
      expect(classifyError(makeError("failed", { syscall: "spawn sh" }))).toBe("process");
    });

    it("classifies spawn without prefix as non-process", () => {
      expect(classifyError(makeError("something unknown", { syscall: "open" }))).toBe("unknown");
    });
  });

  describe("tier priority: name > code > syscall > message", () => {
    it("name wins over code", () => {
      expect(classifyError(makeError("something", { name: "GitError", code: "ENOENT" }))).toBe(
        "git"
      );
    });

    it("code wins over syscall", () => {
      expect(classifyError(makeError("something", { code: "ENOENT", syscall: "spawn sh" }))).toBe(
        "filesystem"
      );
    });

    it("syscall wins over message", () => {
      expect(classifyError(makeError("network error", { syscall: "spawn node" }))).toBe("process");
    });
  });

  describe("tier 4: message fallback", () => {
    it("classifies network messages", () => {
      expect(classifyError(new Error("network request failed"))).toBe("network");
    });

    it("classifies git messages", () => {
      expect(classifyError(new Error("git branch list failed"))).toBe("git");
    });

    it("classifies filesystem messages", () => {
      expect(classifyError(new Error("file not found"))).toBe("filesystem");
    });

    it("classifies process messages", () => {
      expect(classifyError(new Error("terminal crashed"))).toBe("process");
    });

    it("classifies validation messages", () => {
      expect(classifyError(new Error("invalid input"))).toBe("validation");
    });

    it("returns unknown for unrecognized messages", () => {
      expect(classifyError(new Error("something happened"))).toBe("unknown");
    });
  });

  describe("bug cases from issue #4301", () => {
    it("fetch git branch list → git (not network from 'fetch')", () => {
      expect(classifyError(makeError("fetch git branch list", { name: "GitError" }))).toBe("git");
    });

    it("ENOENT with git/directory message → filesystem (code wins)", () => {
      expect(
        classifyError(makeError("invalid directory path for git worktree", { code: "ENOENT" }))
      ).toBe("filesystem");
    });
  });

  describe("edge cases", () => {
    it("handles null", () => {
      expect(classifyError(null)).toBe("unknown");
    });

    it("handles undefined", () => {
      expect(classifyError(undefined)).toBe("unknown");
    });

    it("handles string errors", () => {
      expect(classifyError("git error")).toBe("git");
    });

    it("handles empty object", () => {
      expect(classifyError({})).toBe("unknown");
    });

    it("handles numeric code (not a string)", () => {
      const err = new Error("something") as Error & { code: number };
      err.code = 42;
      expect(classifyError(err)).toBe("unknown");
    });
  });
});

describe("isTransientError", () => {
  describe("code-based detection", () => {
    it.each(["EBUSY", "EAGAIN", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"])(
      "returns true for transient code %s",
      (code) => {
        expect(isTransientError(makeError("something", { code }))).toBe(true);
      }
    );

    it("returns false for ECONNREFUSED (not in transient set)", () => {
      expect(isTransientError(makeError("something", { code: "ECONNREFUSED" }))).toBe(false);
    });

    it("returns false for ENOENT", () => {
      expect(isTransientError(makeError("something", { code: "ENOENT" }))).toBe(false);
    });
  });

  describe("message fallback", () => {
    it("detects timeout in message", () => {
      expect(isTransientError(new Error("connection timeout"))).toBe(true);
    });

    it("detects 429 in message", () => {
      expect(isTransientError(new Error("retry after 429"))).toBe(true);
    });

    it("detects 503 in message", () => {
      expect(isTransientError(new Error("service 503"))).toBe(true);
    });

    it("returns false for non-transient message", () => {
      expect(isTransientError(new Error("file not found"))).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for null", () => {
      expect(isTransientError(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isTransientError(undefined)).toBe(false);
    });

    it("returns false for string errors without transient keywords", () => {
      expect(isTransientError("permanent failure")).toBe(false);
    });
  });
});

describe("getErrorMessage", () => {
  it("extracts message from Error", () => {
    expect(getErrorMessage(new Error("test"))).toBe("test");
  });

  it("returns string directly", () => {
    expect(getErrorMessage("test")).toBe("test");
  });

  it("extracts message from object", () => {
    expect(getErrorMessage({ message: "test" })).toBe("test");
  });

  it("stringifies other types", () => {
    expect(getErrorMessage(42)).toBe("42");
  });
});
