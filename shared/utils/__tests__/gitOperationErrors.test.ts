import { describe, it, expect } from "vitest";
import {
  classifyGitError,
  extractGitErrorMessage,
  getGitRecoveryAction,
  getGitRecoveryHint,
  isMissingGitExecutableError,
  normalizeGitErrorMessage,
} from "../gitOperationErrors.js";
import {
  SIMPLE_GIT_MISSING_BINARY_MESSAGE,
  SIMPLE_GIT_MISSING_CWD_MESSAGE,
  simpleGitMissingBinaryError,
} from "../../testing/simpleGitErrorFixtures.js";
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
      "fatal: unable to access 'https://github.com/acme/private.git/': The requested URL returned error: 403",
    ],
    // `could not read Username` is a transient credential-helper hiccup under
    // GIT_TERMINAL_PROMPT=0, not a durable auth failure — falls through to
    // unknown (a short transient retry) rather than suspending the repo.
    [
      "unknown",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ],
    // Forge secondary rate limit: same 403 URL line as auth, distinguished by
    // the sideband message — must NOT bucket into auth-failed.
    [
      "rate-limited",
      "fatal: unable to access 'https://github.com/x.git/': The requested URL returned error: 403\n" +
        "remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    ],
    ["rate-limited", "remote: You have triggered an abuse detection mechanism."],
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
    ["push-rejected-outdated", "!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)"],
    ["push-rejected-outdated", " ! refs/heads/main:refs/heads/main [rejected] (non-fast-forward)"],
    ["push-rejected-outdated", " ! [rejected]        main -> main (fetch first)"],
    [
      "push-rejected-outdated",
      "hint: Updates were rejected because the tip of your current branch is behind\n" +
        "hint: its remote counterpart.",
    ],
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
      "remote: Authentication failed for 'https://github.com/org/repo.git/'";
    expect(classifyGitError(msg)).toBe("auth-failed");
  });

  it("prefers rate-limited over auth-failed on a secondary-rate-limit 403", () => {
    // A secondary rate limit and a generic 403 share the same `URL returned
    // error: 403` line; the rate-limit signal must win so the repo backs off
    // transiently instead of being treated as a broken credential.
    const msg =
      "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 403\n" +
      "remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
    expect(classifyGitError(msg)).toBe("rate-limited");
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
      "rate-limited",
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
      "git-not-installed",
      "system-io-error",
    ];
    for (const reason of reasons) {
      expect(getGitRecoveryHint(reason)).toBeTruthy();
    }
    expect(getGitRecoveryHint("unknown")).toBeUndefined();
  });
});

describe("classifyGitError — missing git binary", () => {
  it("classifies the real simple-git failure as git-not-installed", () => {
    // Pre-fix this fell through to the generic ENOENT rule and was reported as
    // a filesystem problem, which sent the user looking at their disk instead
    // of installing Git (#11764).
    expect(classifyGitError(simpleGitMissingBinaryError())).toBe("git-not-installed");
    expect(classifyGitError(SIMPLE_GIT_MISSING_BINARY_MESSAGE)).toBe("git-not-installed");
  });

  it("classifies it through a wrapped cause chain", () => {
    // The patterns only ever see the outermost message, which by this point
    // says nothing about spawning — so the guard has to read the raw value.
    const wrapped = new Error("Git operation failed: status", {
      cause: simpleGitMissingBinaryError(["status", "--porcelain"]),
    });

    expect(classifyGitError(wrapped)).toBe("git-not-installed");
  });

  it("still classifies an ordinary filesystem ENOENT as system-io-error", () => {
    // The carve-out must not swallow the generic case it was added in front of.
    expect(classifyGitError("ENOENT: no such file or directory, open '/path/to/file'")).toBe(
      "system-io-error"
    );
    expect(classifyGitError(SIMPLE_GIT_MISSING_CWD_MESSAGE)).not.toBe("git-not-installed");
  });

  it("leaves a classifiable git failure alone when the phrase is only quoted", () => {
    const message = `fatal: detected dubious ownership in repository at '/repos/spawn git ENOENT'`;

    expect(classifyGitError(message)).toBe("dubious-ownership");
  });

  it("lets a classified top-level failure outrank a missing-git ancestor", () => {
    // A wrapper that says nothing specific should defer to its cause, but one
    // that reports a real failure of its own must win — otherwise any error
    // that happened to be wrapped around a spawn ENOENT would be reported as
    // "Git isn't installed" and its actual cause never surfaced.
    const wrapped = new Error("Authentication failed for 'https://github.com/org/repo.git/'", {
      cause: simpleGitMissingBinaryError(),
    });

    expect(classifyGitError(wrapped)).toBe("auth-failed");
  });

  it("outranks the generic filesystem rule when a wrapper quotes its cause", () => {
    // Wrappers that interpolate the cause's message carry "ENOENT" in their
    // own text, which the generic system-io-error rule matches. It must not
    // win: the actionable answer is "install Git", not "check your disk".
    const wrapped = new Error(`Git worktree changes failed: ${SIMPLE_GIT_MISSING_BINARY_MESSAGE}`, {
      cause: simpleGitMissingBinaryError(["status", "--porcelain"]),
    });

    expect(classifyGitError(wrapped)).toBe("git-not-installed");
  });

  it("recognizes the message however the platform ended its lines", () => {
    // Git for Windows is where this failure was reported, and it is also where
    // CRLF turns up.
    const crlf = SIMPLE_GIT_MISSING_BINARY_MESSAGE.replace(/\n/g, "\r\n");

    expect(classifyGitError(new Error(crlf))).toBe("git-not-installed");
    expect(classifyGitError(new Error(`${SIMPLE_GIT_MISSING_BINARY_MESSAGE}\n`))).toBe(
      "git-not-installed"
    );
    expect(classifyGitError(new Error(`${crlf}\r\n`))).toBe("git-not-installed");
  });
});

describe("isMissingGitExecutableError", () => {
  it("recognizes what simple-git actually throws for a missing git binary", () => {
    expect(isMissingGitExecutableError(simpleGitMissingBinaryError())).toBe(true);
  });

  it("recognizes a raw Node spawn error, whose message carries no stack", () => {
    // Nothing laundered it, so both signals are intact and either should do.
    const raw = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
      syscall: "spawn git",
    });

    expect(isMissingGitExecutableError(raw)).toBe(true);
    expect(isMissingGitExecutableError(new Error("spawn git ENOENT"))).toBe(true);
    expect(isMissingGitExecutableError(Object.assign(new Error("opaque"), raw))).toBe(true);
  });

  it("finds it through the wrapping GitService applies", () => {
    // handleGitOperation rewraps failures and keeps the original as `cause`;
    // detection has to survive that or the reported bug reappears.
    const wrapped = new Error("Worktree directory no longer exists", {
      cause: new Error("Git operation failed: getRepositoryRoot", {
        cause: simpleGitMissingBinaryError(),
      }),
    });

    expect(isMissingGitExecutableError(wrapped)).toBe(true);
  });

  it("ignores a spawn failure of some other binary", () => {
    // `createWslHardenedGit` spawns `wsl.exe git` — a missing WSL launcher is
    // not a missing Git, and telling the user to install Git wouldn't help.
    for (const binary of ["node", "wsl.exe", "git-lfs"]) {
      const message = SIMPLE_GIT_MISSING_BINARY_MESSAGE.replace("spawn git", `spawn ${binary}`);
      expect(isMissingGitExecutableError(new Error(message))).toBe(false);
      expect(
        isMissingGitExecutableError(
          Object.assign(new Error(message), { code: "ENOENT", syscall: `spawn ${binary}` })
        )
      ).toBe(false);
    }
  });

  it("ignores the phrase when it is quoted inside a larger message", () => {
    // Anchoring is what separates these from the real thing. A repository path
    // and a hook's own child-process failure both put the exact spawn line in
    // git's output without Git itself being missing.
    const quotedPath = new Error(
      "fatal: detected dubious ownership in repository at '/repos/spawn git ENOENT'"
    );
    const hookOutput = new Error(
      `hook failed:\n${SIMPLE_GIT_MISSING_BINARY_MESSAGE}\nfatal: the remote end hung up`
    );
    const ownLineInStderr = new Error(`remote: spawn git ENOENT\nfatal: push declined`);

    expect(isMissingGitExecutableError(quotedPath)).toBe(false);
    expect(isMissingGitExecutableError(hookOutput)).toBe(false);
    expect(isMissingGitExecutableError(ownLineInStderr)).toBe(false);
  });

  it("does not mistake a missing directory for a missing binary", () => {
    // simple-git never reaches spawn when the cwd is already gone, so this
    // stays a problem with the folder.
    expect(isMissingGitExecutableError(new Error(SIMPLE_GIT_MISSING_CWD_MESSAGE))).toBe(false);
    expect(
      isMissingGitExecutableError(
        Object.assign(new Error("ENOENT: no such file or directory, stat '/gone'"), {
          code: "ENOENT",
          syscall: "stat",
        })
      )
    ).toBe(false);
  });

  it("survives a cause chain that loops", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;

    expect(isMissingGitExecutableError(a)).toBe(false);
  });

  it("handles values that are not errors", () => {
    expect(isMissingGitExecutableError(undefined)).toBe(false);
    expect(isMissingGitExecutableError(null)).toBe(false);
    expect(isMissingGitExecutableError("ENOENT")).toBe(false);
    // classifyGitError accepts bare strings, so the predicate has to too —
    // including one reached partway down a cause chain.
    expect(isMissingGitExecutableError(SIMPLE_GIT_MISSING_BINARY_MESSAGE)).toBe(true);
    expect(
      isMissingGitExecutableError(
        new Error("wrapped", { cause: SIMPLE_GIT_MISSING_BINARY_MESSAGE })
      )
    ).toBe(true);
  });
});

describe("getGitRecoveryAction", () => {
  it("returns structured CTA for key reasons", () => {
    expect(getGitRecoveryAction("auth-failed")).toEqual({
      label: "Sign in with GitHub",
      actionId: "app.settings.openTab",
      args: { tab: "code-forge", subtab: "daintree.github.github" },
    });
    expect(getGitRecoveryAction("push-rejected-outdated")).toEqual({
      label: "Pull and rebase",
      actionId: "git.pullRebase",
    });
    expect(getGitRecoveryAction("conflict-unresolved")).toEqual({
      label: "Resolve conflicts",
      actionId: "worktree.openReviewHub",
    });
    expect(getGitRecoveryAction("dubious-ownership")).toEqual({
      label: "Trust this repo",
      actionId: "git.markSafeDirectory",
    });
  });

  it("returns undefined for reasons without a CTA", () => {
    expect(getGitRecoveryAction("unknown")).toBeUndefined();
    expect(getGitRecoveryAction("system-io-error")).toBeUndefined();
  });
});
