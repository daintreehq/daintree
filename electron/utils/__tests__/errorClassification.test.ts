import { describe, expect, it } from "vitest";
import { classifyError } from "../errorClassification.js";
import {
  ConfigError,
  FileSystemError,
  GitError,
  GitOperationError,
  ProcessError,
} from "../errorTypes.js";

function errno(code: string, message: string, syscall?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  if (syscall) err.syscall = syscall;
  return err;
}

describe("classifyError", () => {
  // ── DaintreeError subclass classification ──────────────────────────

  it("classifies ProcessError", () => {
    const result = classifyError(new ProcessError("pty failed"));
    expect(result.errorType).toBe("process");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("terminal process");
    expect(result.isCritical).toBe(false);
  });

  it("classifies ConfigError", () => {
    const result = classifyError(new ConfigError("bad config"));
    expect(result.errorType).toBe("config");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("corrupted");
    expect(result.isCritical).toBe(true);
  });

  it("classifies FileSystemError", () => {
    const result = classifyError(new FileSystemError("io error"));
    expect(result.errorType).toBe("filesystem");
    expect(result.retryability).toBe("none");
    expect(result.isCritical).toBe(true);
  });

  it("classifies GitError", () => {
    const result = classifyError(new GitError("fatal: not a git repository"));
    expect(result.errorType).toBe("git");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("git init");
    expect(result.gitReason).toBeUndefined();
    expect(result.recoveryAction).toBeUndefined();
  });

  it("classifies GitOperationError and extracts reason", () => {
    const result = classifyError(
      new GitOperationError("auth-failed", "Authentication failed", {
        cwd: "/repo",
        op: "push",
      })
    );
    expect(result.errorType).toBe("git");
    expect(result.gitReason).toBe("auth-failed");
    expect(result.recoveryHint).toContain("credentials");
    expect(result.recoveryAction).toEqual({
      label: "Sign in with GitHub",
      actionId: "app.settings.openTab",
      args: { tab: "code-forge", subtab: "github" },
    });
  });

  it("classifies GitOperationError with push-rejected-outdated", () => {
    const result = classifyError(
      new GitOperationError("push-rejected-outdated", "non-fast-forward")
    );
    expect(result.errorType).toBe("git");
    expect(result.recoveryAction).toEqual({
      label: "Pull and rebase",
      actionId: "git.pullRebase",
    });
  });

  it("returns undefined recoveryHint for GitError with unrecognized message", () => {
    const result = classifyError(new GitError("merge failed"));
    expect(result.errorType).toBe("git");
    expect(result.recoveryHint).toBeUndefined();
  });

  it("checks cause message for git hints", () => {
    const result = classifyError(
      new GitError(
        "Git operation failed: status",
        { rootPath: "/tmp" },
        new Error("fatal: not a git repository (or any parent up to mount point /)")
      )
    );
    expect(result.recoveryHint).toContain("git init");
  });

  // ── Errno code classification (non-Daintree errors) ─────────────────

  it("classifies ENOENT (file not found)", () => {
    const result = classifyError(errno("ENOENT", "ENOENT: no such file", "open"));
    expect(result.errorType).toBe("unknown");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("file path");
  });

  it("classifies ENOENT with spawn syscall", () => {
    const result = classifyError(errno("ENOENT", "ENOENT", "spawn npm"));
    expect(result.errorType).toBe("unknown");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("PATH");
  });

  it("classifies EACCES (permission)", () => {
    const result = classifyError(errno("EACCES", "EACCES: permission denied", "open"));
    expect(result.errorType).toBe("unknown");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("permissions");
  });

  it("classifies EACCES with spawn syscall", () => {
    const result = classifyError(errno("EACCES", "EACCES", "spawn git"));
    expect(result.errorType).toBe("unknown");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("executable");
  });

  it("classifies ECONNREFUSED as network", () => {
    const result = classifyError(errno("ECONNREFUSED", "connect ECONNREFUSED"));
    expect(result.errorType).toBe("network");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("server");
  });

  it("classifies ENOTFOUND as network and transient", () => {
    const result = classifyError(errno("ENOTFOUND", "getaddrinfo ENOTFOUND"));
    expect(result.errorType).toBe("network");
    expect(result.retryability).toBe("auto");
    expect(result.recoveryHint).toContain("DNS");
  });

  it("classifies ETIMEDOUT as network and transient", () => {
    const result = classifyError(errno("ETIMEDOUT", "connect ETIMEDOUT"));
    expect(result.errorType).toBe("network");
    expect(result.retryability).toBe("auto");
    expect(result.recoveryHint).toContain("network");
    expect(result.recoveryHint).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  it("classifies ECONNRESET as transient", () => {
    const result = classifyError(errno("ECONNRESET", "read ECONNRESET"));
    expect(result.retryability).toBe("auto");
    expect(result.recoveryHint).toContain("reset");
  });

  it("classifies EBUSY as transient", () => {
    const result = classifyError(errno("EBUSY", "EBUSY: resource busy"));
    expect(result.retryability).toBe("auto");
    expect(result.recoveryHint).toContain("Close");
  });

  it("classifies EAGAIN as transient", () => {
    const result = classifyError(errno("EAGAIN", "EAGAIN"));
    expect(result.retryability).toBe("auto");
    expect(result.recoveryHint).toContain("busy");
  });

  it("classifies EMFILE (resource exhaustion, not transient)", () => {
    const result = classifyError(errno("EMFILE", "EMFILE: too many open files"));
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("file descriptors");
  });

  it("classifies ENOMEM (resource exhaustion, not transient)", () => {
    const result = classifyError(errno("ENOMEM", "ENOMEM"));
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("memory");
  });

  // ── TLS proxy classification ──────────────────────────────────────

  it.each([
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self signed certificate in certificate chain"],
    ["CERT_UNTRUSTED", "certificate not trusted"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self signed certificate"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames"],
  ])("classifies TLS code %s as network", (errCode, errMsg) => {
    const error = errno(errCode, errMsg);
    const result = classifyError(error);
    expect(result.errorType).toBe("network");
    expect(result.retryability).toBe("none");
    expect(result.recoveryHint).toContain("NODE_EXTRA_CA_CERTS");
    expect(result.recoveryHint).toContain("NODE_USE_SYSTEM_CA");
  });

  it("falls back to message substring for TLS detection when code is missing", () => {
    const result = classifyError(new Error("self signed certificate in certificate chain"));
    expect(result.errorType).toBe("network");
    expect(result.recoveryHint).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("does NOT classify unrelated 'unable to verify' message as TLS", () => {
    const result = classifyError(new Error("unable to verify user permissions"));
    expect(result.errorType).toBe("unknown");
    if (result.recoveryHint) {
      expect(result.recoveryHint).not.toContain("NODE_EXTRA_CA_CERTS");
    }
  });

  it("does NOT classify CERT_HAS_EXPIRED as TLS proxy", () => {
    const error = errno("CERT_HAS_EXPIRED", "certificate has expired");
    const result = classifyError(error);
    if (result.recoveryHint) {
      expect(result.recoveryHint).not.toContain("NODE_EXTRA_CA_CERTS");
    }
  });

  // ── Spawn syscall edge cases ──────────────────────────────────────

  it("returns PATH hint for posix_spawnp message without code", () => {
    const result = classifyError(new Error("posix_spawnp: No such file or directory"));
    expect(result.recoveryHint).toContain("PATH");
  });

  it("returns PATH hint for spawn syscall without code", () => {
    const err = new Error("spawn failed") as NodeJS.ErrnoException;
    err.syscall = "spawn bash";
    const result = classifyError(err);
    expect(result.recoveryHint).toContain("PATH");
  });

  // ── DaintreeError with errno code (retryability from errno) ──────

  it("correctly reflects retryability for DaintreeError subclass (ProcessError)", () => {
    // ProcessError has no errno code, so retryability is "none"
    const result = classifyError(new ProcessError("pty failed"));
    expect(result.errorType).toBe("process");
    expect(result.retryability).toBe("none");
  });

  it("correctly reflects retryability for plain Error with transient code", () => {
    // Only raw errno-exposed errors (not wrapped in DaintreeError subclasses)
    // carry transient retryability, matching the legacy isTransientError behavior
    // which only checks (error as NodeJS.ErrnoException).code.
    const err = new Error("EBUSY") as NodeJS.ErrnoException;
    err.code = "EBUSY";
    const result = classifyError(err);
    expect(result.retryability).toBe("auto");
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("classifies null/undefined as unknown", () => {
    for (const input of [null, undefined, 42, "string"]) {
      const result = classifyError(input);
      expect(result.errorType).toBe("unknown");
      expect(result.retryability).toBe("none");
      expect(result.recoveryHint).toBeUndefined();
    }
  });

  it("is pure — same input returns same classification", () => {
    const error = errno("ENOENT", "no such file", "spawn npm");
    const a = classifyError(error);
    const b = classifyError(error);
    expect(a).toEqual(b);
  });

  it("returns correct shape for every ErrorClassification field", () => {
    const result = classifyError(new GitOperationError("conflict-unresolved", "CONFLICT in merge"));
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "errorType",
      "gitReason",
      "isCritical",
      "recoveryAction",
      "recoveryHint",
      "retryability",
    ]);
    expect(result.errorType).toBe("git");
    expect(result.gitReason).toBe("conflict-unresolved");
    expect(result.isCritical).toBe(false);
    expect(result.recoveryAction).toEqual({
      label: "Resolve conflicts",
      actionId: "worktree.openReviewHub",
    });
  });

  it("classifies validation errors from ValidationError subclass", async () => {
    const { ValidationError } = await import("../../ipc/validationError.js");
    const result = classifyError(new ValidationError("invalid input"));
    expect(result.errorType).toBe("validation");
    expect(result.retryability).toBe("none");
  });
});
