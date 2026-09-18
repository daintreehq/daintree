import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (error: unknown, stdout: string, stderr: string) => void;
type ExecOptions = {
  env: NodeJS.ProcessEnv;
  encoding: string;
  maxBuffer: number;
  signal: AbortSignal;
  windowsHide: boolean;
};

const childProcessMock = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcessMock);

const environmentMock = vi.hoisted(() => ({ refreshPath: vi.fn(async () => {}) }));
vi.mock("../../../../../electron/setup/environment.js", () => environmentMock);

const tokenMock = vi.hoisted(() => ({ validateGitHubToken: vi.fn() }));
vi.mock("../GitHubToken.js", () => tokenMock);

import {
  GH_TOKEN_TIMEOUT_MS,
  buildGhCredentialEnv,
  credentialImportCapability,
  readGhToken,
} from "../GitHubCliCredential.js";

const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";

function execError(fields: Record<string, unknown>): Error {
  // The real message quotes the command and whatever gh printed — including,
  // on some failures, the token. Nothing may read it.
  return Object.assign(new Error(`Command failed: gh auth token ${TOKEN}`), fields);
}

/** Make the next `gh` run answer asynchronously, like a real child. */
function ghAnswers(error: unknown, stdout = "", stderr = "") {
  childProcessMock.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: ExecOptions, cb: ExecCallback) => {
      queueMicrotask(() => cb(error, stdout, stderr));
      return {};
    }
  );
}

/** Make `gh` hang until its abort signal fires, like a pending keychain prompt. */
function ghHangs() {
  childProcessMock.execFile.mockImplementation(
    (_cmd: string, _args: string[], opts: ExecOptions, cb: ExecCallback) => {
      opts.signal.addEventListener("abort", () =>
        cb(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), "", "")
      );
      return {};
    }
  );
}

function lastExec(): { cmd: string; args: string[]; opts: ExecOptions } {
  const call = childProcessMock.execFile.mock.calls.at(-1)!;
  return { cmd: call[0], args: call[1], opts: call[2] };
}

function validAs(username: string, scopes: string[] = ["repo", "read:org"]) {
  tokenMock.validateGitHubToken.mockResolvedValue({ valid: true, scopes, username });
}

beforeEach(() => {
  vi.clearAllMocks();
  environmentMock.refreshPath.mockImplementation(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildGhCredentialEnv", () => {
  it("strips every inherited token so gh reports its stored login", () => {
    const env = buildGhCredentialEnv(
      {
        PATH: "/usr/bin",
        GH_TOKEN: "a",
        GITHUB_TOKEN: "b",
        GH_ENTERPRISE_TOKEN: "c",
        GITHUB_ENTERPRISE_TOKEN: "d",
        GH_CONFIG_DIR: "/cfg",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
      },
      "linux"
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      GH_CONFIG_DIR: "/cfg",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
      GH_PROMPT_DISABLED: "1",
      GH_TERMINAL_PROMPT: "0",
    });
  });

  it("matches token keys case-insensitively on Windows", () => {
    const env = buildGhCredentialEnv(
      { Path: "C:\\bin", gh_token: "a", Github_Token: "b", gh_prompt_disabled: "0" },
      "win32"
    );
    expect(env).toEqual({ Path: "C:\\bin", GH_PROMPT_DISABLED: "1", GH_TERMINAL_PROMPT: "0" });
  });

  it("matches case-sensitively elsewhere, where a differently-cased key is a different variable", () => {
    const env = buildGhCredentialEnv({ gh_token: "kept", GH_TOKEN: "stripped" }, "darwin");
    expect(env.gh_token).toBe("kept");
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it("doesn't mutate the source env", () => {
    const source = { GH_TOKEN: "a" };
    buildGhCredentialEnv(source, "linux");
    expect(source).toEqual({ GH_TOKEN: "a" });
  });
});

describe("readGhToken", () => {
  it("refreshes PATH, then runs gh non-interactively for github.com", async () => {
    const order: string[] = [];
    environmentMock.refreshPath.mockImplementation(async () => {
      order.push("refreshPath");
    });
    childProcessMock.execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: ExecOptions, cb: ExecCallback) => {
        order.push("execFile");
        queueMicrotask(() => cb(null, `${TOKEN}\n`, ""));
        return {};
      }
    );

    await expect(readGhToken()).resolves.toEqual({ token: TOKEN });

    expect(order).toEqual(["refreshPath", "execFile"]);
    const { cmd, args, opts } = lastExec();
    expect(cmd).toBe("gh");
    expect(args).toEqual(["auth", "token", "--hostname", "github.com"]);
    expect(opts.windowsHide).toBe(true);
    expect(opts.maxBuffer).toBeGreaterThan(0);
    expect(opts.env.GH_PROMPT_DISABLED).toBe("1");
  });

  it("strips the app's own inherited tokens from the child env", async () => {
    vi.stubEnv("GH_TOKEN", "inherited-token");
    vi.stubEnv("GITHUB_TOKEN", "inherited-token");
    try {
      ghAnswers(null, TOKEN);
      await readGhToken();
      const { env } = lastExec().opts;
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still runs gh when the PATH refresh fails", async () => {
    environmentMock.refreshPath.mockRejectedValue(new Error("shell env timed out"));
    ghAnswers(null, TOKEN);
    await expect(readGhToken()).resolves.toEqual({ token: TOKEN });
  });

  it.each([
    ["a missing gh binary", { code: "ENOENT" }, "cli-not-found"],
    ["a non-zero exit", { code: 1 }, "not-signed-in"],
    ["output over the buffer cap", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "invalid-output"],
    ["an unrecognised failure", { code: "EACCES" }, "cli-failed"],
  ])("maps %s to a fixed reason", async (_label, fields, reason) => {
    ghAnswers(execError(fields), TOKEN, `no token found for github.com ${TOKEN}`);
    const result = await readGhToken();
    expect(result).toEqual({ unavailable: true, reason });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each([
    ["empty output", ""],
    ["several lines", `${TOKEN}\n${TOKEN}`],
    ["a prompt", "? Authenticate Git with your GitHub credentials?"],
    ["a too-short value", "gho_abc"],
  ])("rejects %s as invalid output", async (_label, stdout) => {
    ghAnswers(null, stdout);
    await expect(readGhToken()).resolves.toEqual({ unavailable: true, reason: "invalid-output" });
  });

  it.each([
    ["an OAuth token", TOKEN],
    ["a classic PAT", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["a fine-grained PAT", `github_pat_11ABCDEFG0${"x".repeat(72)}`],
    ["a legacy 40-hex token", "0123456789abcdef0123456789abcdef01234567"],
  ])("accepts %s", async (_label, token) => {
    ghAnswers(null, `  ${token}\r\n`);
    await expect(readGhToken()).resolves.toEqual({ token });
  });

  it("contains a synchronous spawn failure", async () => {
    childProcessMock.execFile.mockImplementation(() => {
      throw new Error(`spawn failed ${TOKEN}`);
    });
    const result = await readGhToken();
    expect(result).toEqual({ unavailable: true, reason: "cli-failed" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("times out as a bounded failure, not as signed out", async () => {
    vi.useFakeTimers();
    ghHangs();
    const pending = readGhToken();
    await vi.advanceTimersByTimeAsync(GH_TOKEN_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ unavailable: true, reason: "cli-timeout" });
    expect(lastExec().opts.signal.aborted).toBe(true);
  });

  it("kills gh and reports cancellation when the caller aborts", async () => {
    ghHangs();
    const controller = new AbortController();
    const pending = readGhToken(controller.signal);
    await vi.waitFor(() => expect(childProcessMock.execFile).toHaveBeenCalled());
    controller.abort();
    await expect(pending).resolves.toEqual({ unavailable: true, reason: "cancelled" });
    expect(lastExec().opts.signal.aborted).toBe(true);
  });

  it("never runs gh when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readGhToken(controller.signal)).resolves.toEqual({
      unavailable: true,
      reason: "cancelled",
    });
    expect(childProcessMock.execFile).not.toHaveBeenCalled();
  });
});

describe("credentialImportCapability.preview", () => {
  it("returns the account and scopes without the token", async () => {
    ghAnswers(null, TOKEN);
    validAs("octocat", ["repo", "admin:org", "gist"]);

    const result = await credentialImportCapability.preview();

    expect(result).toEqual({
      account: "octocat",
      scopes: ["repo", "admin:org", "gist"],
      missingScopes: [],
      source: "gh",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(tokenMock.validateGitHubToken).toHaveBeenCalledWith(TOKEN, undefined);
  });

  it("reports missing scopes, and none when GitHub reported no scopes at all", async () => {
    ghAnswers(null, TOKEN);
    validAs("octocat", ["public_repo"]);
    await expect(credentialImportCapability.preview()).resolves.toMatchObject({
      missingScopes: ["repo", "read:org"],
    });

    validAs("octocat", []);
    await expect(credentialImportCapability.preview()).resolves.toMatchObject({
      scopes: [],
      missingScopes: [],
    });
  });

  it("threads the caller's signal into validation", async () => {
    ghAnswers(null, TOKEN);
    validAs("octocat");
    const controller = new AbortController();
    await credentialImportCapability.preview(controller.signal);
    expect(tokenMock.validateGitHubToken).toHaveBeenCalledWith(TOKEN, controller.signal);
  });

  it("drops the validator's error text and returns a fixed code", async () => {
    ghAnswers(null, TOKEN);
    tokenMock.validateGitHubToken.mockResolvedValue({
      valid: false,
      scopes: [],
      error: `request with ${TOKEN} failed`,
    });
    const result = await credentialImportCapability.preview();
    expect(result).toEqual({ unavailable: true, reason: "validation-failed" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("treats a thrown validation as a failed one", async () => {
    ghAnswers(null, TOKEN);
    tokenMock.validateGitHubToken.mockRejectedValue(new Error(TOKEN));
    await expect(credentialImportCapability.preview()).resolves.toEqual({
      unavailable: true,
      reason: "validation-failed",
    });
  });

  it("refuses a valid token that GitHub attributes to no account", async () => {
    ghAnswers(null, TOKEN);
    tokenMock.validateGitHubToken.mockResolvedValue({ valid: true, scopes: ["repo"] });
    await expect(credentialImportCapability.preview()).resolves.toEqual({
      unavailable: true,
      reason: "validation-failed",
    });
  });

  it("reports cancellation when the signal aborts during validation", async () => {
    ghAnswers(null, TOKEN);
    const controller = new AbortController();
    tokenMock.validateGitHubToken.mockImplementation(async () => {
      controller.abort();
      return { valid: false, scopes: [], error: "This operation was aborted" };
    });
    await expect(credentialImportCapability.preview(controller.signal)).resolves.toEqual({
      unavailable: true,
      reason: "cancelled",
    });
  });

  it("passes a CLI failure straight through without validating", async () => {
    ghAnswers(execError({ code: 1 }));
    await expect(credentialImportCapability.preview()).resolves.toEqual({
      unavailable: true,
      reason: "not-signed-in",
    });
    expect(tokenMock.validateGitHubToken).not.toHaveBeenCalled();
  });
});

describe("credentialImportCapability.commit", () => {
  it("reads and validates again, then hands the token back to the host", async () => {
    ghAnswers(null, TOKEN);
    validAs("octocat", ["repo", "read:org", "workflow"]);

    const result = await credentialImportCapability.commit({ account: "octocat" });

    expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
    expect(tokenMock.validateGitHubToken).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      credentials: { token: TOKEN },
      validation: {
        valid: true,
        scopes: ["repo", "read:org", "workflow"],
        expiresAt: null,
        account: "octocat",
      },
    });
  });

  it("matches the previewed account case-insensitively, as GitHub logins are", async () => {
    ghAnswers(null, TOKEN);
    validAs("OctoCat");
    await expect(credentialImportCapability.commit({ account: "octocat" })).resolves.toMatchObject({
      validation: { account: "OctoCat" },
    });
  });

  it("refuses when gh switched accounts after the preview", async () => {
    ghAnswers(null, TOKEN);
    validAs("someone-else");
    const result = await credentialImportCapability.commit({ account: "octocat" });
    expect(result).toEqual({ unavailable: true, reason: "account-changed" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("passes a read failure through", async () => {
    ghAnswers(execError({ code: "ENOENT" }));
    await expect(credentialImportCapability.commit({ account: "octocat" })).resolves.toEqual({
      unavailable: true,
      reason: "cli-not-found",
    });
  });
});
