import { describe, it, expect } from "vitest";
import {
  classifyGitError,
  extractGitErrorMessage,
  getGitRecoveryAction,
  getGitRecoveryHint,
  normalizeGitErrorMessage,
} from "../gitOperationErrors.js";
import type { GitOperationReason } from "../../types/ipc/errors.js";

describe("classifyGitError — table-driven", () => {
  it.each<[GitOperationReason, string]>([
    ["not-a-repository", "fatal: not a git repository (or any of the parent directories): .git"],
    [
      "dubious-ownership",
      "fatal: detected dubious ownership in repository at '/Users/greg/code/repo'",
    ],
    ["auth-failed", "remote: Authentication failed for 'https://github.com/org/repo.git/'"],
    ["auth-failed", "Permission denied (publickey)."],
    [
      "auth-failed",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ],
    [
      "auth-failed",
      "fatal: unable to access 'https://github.com/acme/private.git/': The requested URL returned error: 403",
    ],
    ["repository-not-found", "remote: ERROR: Repository not found."],
    ["repository-not-found", "fatal: repository 'https://github.com/foo/bar.git/' not found"],
    [
      "repository-not-found",
      "fatal: Could not read from remote repository.\nPlease make sure you have the correct access rights",
    ],
    [
      "network-unavailable",
      "fatal: unable to access 'https://github.com/foo.git/': Could not resolve host: github.com",
    ],
    [
      "network-unavailable",
      "fatal: unable to access 'https://github.com/foo.git/': Failed to connect to github.com port 443: Connection refused",
    ],
    [
      "network-unavailable",
      "fatal: unable to access 'https://github.com/foo.git/': The requested URL returned error: 503",
    ],
    ["hook-rejected", " ! [remote rejected] main -> main (pre-receive hook declined)"],
    ["hook-rejected", " ! [remote rejected] feature -> feature (update hook declined)"],
    [
      "push-rejected-policy",
      "remote: error: GH006: Protected branch update failed for refs/heads/main.",
    ],
    [
      "push-rejected-policy",
      "remote: error: GH013: Repository rule violations found for refs/heads/main.",
    ],
    [
      "push-rejected-policy",
      " ! [remote rejected] main -> main (push declined due to repository rule violations)",
    ],
    ["push-rejected-policy", "remote: pack exceeds maximum allowed size"],
    ["push-rejected-outdated", " ! [rejected]        main -> main (non-fast-forward)"],
    ["conflict-unresolved", "CONFLICT (content): Merge conflict in src/index.ts"],
    ["conflict-unresolved", "error: merge is not possible because you have unmerged files."],
    [
      "worktree-dirty",
      "error: Your local changes to the following files would be overwritten by merge:\n\tfoo.ts",
    ],
    ["pathspec-invalid", "fatal: bad revision 'HEAD~999'"],
    ["pathspec-invalid", "fatal: pathspec 'nonexistent' did not match any file(s) known to git"],
    ["pathspec-invalid", "fatal: couldn't find remote ref pull/99999/head"],
    [
      "lfs-missing",
      "Smudge error: Error downloading file.bin: external filter 'git-lfs filter-process' failed",
    ],
    [
      "lfs-quota-exceeded",
      "batch response: This repository exceeded its LFS budget. Please contact the owner.",
    ],
    [
      "lfs-quota-exceeded",
      "batch response: This repository is over its data quota. Please contact the owner.",
    ],
    ["lfs-quota-exceeded", "You have reached the free storage limit of 10 GiB for Git LFS"],
    ["lfs-quota-exceeded", "VS403658: You cannot upload more than 10 GB of Git LFS files"],
    [
      "lfs-quota-exceeded",
      "fatal: unable to access 'https://dev.azure.com/org/_git/repo.git/': The requested URL returned error: HTTP 413 LFS upload too large",
    ],
    ["config-missing", "fatal: The current branch feature/foo has no upstream branch."],
    ["config-missing", "fatal: no upstream configured for branch 'feature/foo'"],
    ["config-missing", "fatal: unable to read config file '/etc/gitconfig': Permission denied"],
    ["system-io-error", "ENOENT: no such file or directory, open '/path/to/file'"],
    ["system-io-error", "could not create work tree dir '/path/to/wt': Permission denied"],
    ["unknown", "some completely unrecognized git message"],
    ["unknown", ""],
  ])("maps %s from %j", (expected, input) => {
    expect(classifyGitError(input)).toBe(expected);
  });
});

describe("classifyGitError — ordering and normalization", () => {
  it("strips 'remote: ' prefix before matching (picks classified reason over raw string)", () => {
    // Without remote: prefix stripping, the ' ! [rejected] ... (non-fast-forward)' line would
    // be the only match — classifier must see the hook-rejected text after stripping.
    const msg =
      "remote:  ! [remote rejected] main -> main (pre-receive hook declined)\n" +
      " ! [rejected]        main -> main (non-fast-forward)";
    expect(classifyGitError(msg)).toBe("hook-rejected");
  });

  it("classifies GH006 Protected branch when only policy signal is present", () => {
    const msg =
      "remote: error: GH006: Protected branch update failed for refs/heads/main.\n" +
      "remote: error: Required status check 'ci-ok' was not run on this commit";
    expect(classifyGitError(msg)).toBe("push-rejected-policy");
  });

  it("prefers hook-rejected over push-rejected-outdated when both present (VS Code #229011)", () => {
    const msg =
      "remote: Hook error details...\n" +
      " ! [remote rejected] main -> main (pre-receive hook declined)\n" +
      " ! [rejected]        main -> main (non-fast-forward)";
    expect(classifyGitError(msg)).toBe("hook-rejected");
  });

  it("normalizes CRLF before matching", () => {
    const msg = "remote: Repository not found.\r\nfatal: Could not read from remote repository.";
    expect(classifyGitError(msg)).toBe("repository-not-found");
  });

  it("handles plain Error objects", () => {
    const err = new Error("fatal: not a git repository");
    expect(classifyGitError(err)).toBe("not-a-repository");
  });

  it("handles non-Error input (null/undefined)", () => {
    expect(classifyGitError(null)).toBe("unknown");
    expect(classifyGitError(undefined)).toBe("unknown");
  });

  it("handles non-Error input (number, object)", () => {
    expect(classifyGitError(42)).toBe("unknown");
    expect(classifyGitError({})).toBe("unknown");
  });

  it("matches case-insensitively where appropriate", () => {
    expect(classifyGitError("authentication failed")).toBe("auth-failed");
    expect(classifyGitError("AUTHENTICATION FAILED")).toBe("auth-failed");
    // push-rejected-outdated is also case-insensitive to survive wording drift
    expect(classifyGitError(" ! [Rejected]        main -> main (Non-Fast-Forward)")).toBe(
      "push-rejected-outdated"
    );
  });

  it("prefers network-unavailable over repository-not-found when both signals appear", () => {
    const msg =
      "fatal: Could not read from remote repository.\n" +
      "fatal: unable to access 'https://github.com/foo.git/': Could not resolve host: github.com";
    expect(classifyGitError(msg)).toBe("network-unavailable");
  });

  it("prefers auth-failed over repository-not-found when both signals appear", () => {
    const msg =
      "fatal: Could not read from remote repository.\n" +
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    expect(classifyGitError(msg)).toBe("auth-failed");
  });

  it("prefers lfs-quota-exceeded over lfs-missing when both signals appear", () => {
    // Regardless of PATTERNS order, a quota signal is the more actionable root
    // cause when a user sees both (the filter-process failure is a downstream
    // consequence of the quota block, not a missing binary).
    const msg =
      "Smudge error: external filter 'git-lfs filter-process' failed\n" +
      "batch response: This repository exceeded its LFS budget";
    expect(classifyGitError(msg)).toBe("lfs-quota-exceeded");
  });

  it("prefers lfs-quota-exceeded over auth-failed on HTTP 403 batch responses (GitHub LFS)", () => {
    // Regression: GitHub's LFS batch API returns HTTP 403 when the repo exceeds
    // its LFS quota. Before the ordering fix, `auth-failed` matched the 403
    // fragment first and users saw "Sign in with GitHub" instead of a quota
    // explanation. The quota signal must win the tie.
    const msg =
      "batch response: This repository exceeded its LFS budget. Please contact the owner.\n" +
      "error: failed to push some refs to 'https://github.com/acme/media.git'\n" +
      "fatal: unable to access 'https://github.com/acme/media.git/': The requested URL returned error: 403";
    expect(classifyGitError(msg)).toBe("lfs-quota-exceeded");
  });

  it("does not classify a general GitLab namespace storage-limit message as lfs-quota-exceeded", () => {
    // The regex arm for `reached ... free storage limit` requires an LFS token
    // nearby so that a plain namespace-level storage warning does not
    // misclassify as LFS-specific.
    const msg = "You have reached the free storage limit of 5 GiB for your namespace";
    expect(classifyGitError(msg)).toBe("unknown");
  });

  it("combines CRLF, remote-stripping, and ordering for hook rejection", () => {
    const msg =
      "remote:  ! [remote rejected] main -> main (pre-receive hook declined)\r\n" +
      " ! [rejected]        main -> main (non-fast-forward)";
    expect(classifyGitError(msg)).toBe("hook-rejected");
  });
});

describe("extractGitErrorMessage", () => {
  it("returns message from an Error instance", () => {
    expect(extractGitErrorMessage(new Error("hello"))).toBe("hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractGitErrorMessage(null)).toBe("");
    expect(extractGitErrorMessage(undefined)).toBe("");
  });

  it("returns strings as-is", () => {
    expect(extractGitErrorMessage("plain")).toBe("plain");
  });

  it("reads .message from error-shaped objects", () => {
    expect(extractGitErrorMessage({ message: "shaped" })).toBe("shaped");
  });

  it("coerces primitives", () => {
    expect(extractGitErrorMessage(42)).toBe("42");
  });
});

describe("normalizeGitErrorMessage", () => {
  it("strips CRLF", () => {
    expect(normalizeGitErrorMessage("a\r\nb")).toBe("a\nb");
  });

  it("strips remote: prefix from every line", () => {
    expect(normalizeGitErrorMessage("remote: line1\nremote: line2")).toBe("line1\nline2");
  });

  it("only strips remote: at line starts", () => {
    // Host URLs like 'remote: example.com' (without space match anchor) should not corrupt non-prefixed content
    expect(normalizeGitErrorMessage("other text remote: inline")).toBe("other text remote: inline");
  });
});

describe("getGitRecoveryHint", () => {
  it("returns a hint for every reason except 'unknown'", () => {
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
    for (const reason of reasons) {
      expect(getGitRecoveryHint(reason)).toBeTruthy();
    }
    expect(getGitRecoveryHint("unknown")).toBeUndefined();
  });
});

describe("getGitRecoveryAction", () => {
  it("returns structured CTA for key reasons", () => {
    expect(getGitRecoveryAction("auth-failed")).toEqual({
      label: "Sign in with GitHub",
      actionId: "github.auth",
    });
    expect(getGitRecoveryAction("push-rejected-outdated")).toEqual({
      label: "Pull latest",
      actionId: "git.pull",
    });
    expect(getGitRecoveryAction("conflict-unresolved")).toEqual({
      label: "Resolve conflicts",
      actionId: "git.resolveConflicts",
    });
    expect(getGitRecoveryAction("dubious-ownership")).toEqual({
      label: "Trust this repo",
      actionId: "git.trustRepository",
    });
  });

  it("returns undefined for reasons without a CTA", () => {
    expect(getGitRecoveryAction("unknown")).toBeUndefined();
    expect(getGitRecoveryAction("system-io-error")).toBeUndefined();
  });
});
