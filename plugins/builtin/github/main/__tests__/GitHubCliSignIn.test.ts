import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHostApi, PluginTypedIpcHandler } from "../../../../../shared/types/plugin.js";

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => childProcessMock);

const environmentMock = vi.hoisted(() => ({ refreshPath: vi.fn(async () => {}) }));
vi.mock("../../../../../electron/setup/environment.js", () => environmentMock);

const lookupMock = vi.hoisted(() => ({
  resolveExecutableForSpawn: vi.fn(async () => "/usr/local/bin/gh"),
}));
vi.mock("../../../../../electron/utils/windowsExecutable.js", () => lookupMock);

const storedMock = vi.hoisted(() => ({
  buildStoredCredentials: vi.fn<(id: string) => { kind: "bearer"; value: string } | null>(
    () => null
  ),
}));
vi.mock("../../../../../electron/services/forge/forgeCredentialUtils.js", () => storedMock);

import {
  GH_KILL_GRACE_MS,
  GH_LOGIN_TIMEOUT_MS,
  parseGhAuthStatusJson,
  parseGhAuthStatusText,
  readGhAccount,
  registerGhSignIn,
  signInGhWithToken,
} from "../GitHubCliSignIn.js";
import { setEnterpriseHost } from "../GitHubHost.js";
import { GH_SIGN_IN_CHANNELS, type GhSignInResult } from "../../shared/ghSignIn.js";

const TOKEN = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
const OTHER_TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface GhAnswer {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  /** Never exits on its own. */
  hang?: boolean;
  /** With `hang`: ignores SIGTERM, exiting only on SIGKILL. */
  ignoreTerm?: boolean;
  /** Fails to start, like a missing binary. */
  spawnError?: NodeJS.ErrnoException;
  /** Starts with no pipes, like a spawn that ran out of file descriptors. */
  noPipes?: boolean;
}

interface SpawnRecord {
  cmd: string;
  args: string[];
  opts: { env: NodeJS.ProcessEnv; stdio: unknown; shell?: unknown };
  stdin: string;
  kills: string[];
}

const spawned: SpawnRecord[] = [];
let answers: GhAnswer[] = [];

function ghAnswers(...next: GhAnswer[]) {
  answers = next;
}

type FakeChild = EventEmitter & {
  stdout: PassThrough | null;
  stderr: PassThrough | null;
  stdin: Writable | null;
  exitCode: number | null;
  signalCode: string | null;
  kill: (signal?: string) => boolean;
};

beforeEach(() => {
  vi.clearAllMocks();
  spawned.length = 0;
  answers = [];
  setEnterpriseHost(null);
  lookupMock.resolveExecutableForSpawn.mockImplementation(async () => "/usr/local/bin/gh");
  childProcessMock.spawn.mockImplementation(
    (cmd: string, args: string[], opts: SpawnRecord["opts"]) => {
      const record: SpawnRecord = { cmd, args, opts, stdin: "", kills: [] };
      spawned.push(record);
      const answer = answers.shift() ?? { code: 0 };
      const child = new EventEmitter() as FakeChild;
      child.exitCode = null;
      child.signalCode = null;
      const exit = (code: number | null, signal: string | null) => {
        child.exitCode = code;
        child.signalCode = signal;
        child.emit("exit", code, signal);
        child.emit("close", code, signal);
      };
      child.kill = (signal = "SIGTERM") => {
        record.kills.push(signal);
        if (answer.ignoreTerm && signal !== "SIGKILL") return true;
        queueMicrotask(() => exit(null, signal));
        return true;
      };
      if (answer.noPipes) {
        child.stdout = child.stderr = child.stdin = null;
        queueMicrotask(() =>
          child.emit("error", Object.assign(new Error("EMFILE"), { code: "EMFILE" }))
        );
        return child;
      }
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          record.stdin += String(chunk);
          callback();
        },
      });
      if (answer.spawnError) {
        queueMicrotask(() => child.emit("error", answer.spawnError));
        return child;
      }
      if (answer.hang) return child;
      child.stdin.once("finish", () => {
        child.stdout!.end(answer.stdout ?? "");
        child.stderr!.end(answer.stderr ?? "");
        setTimeout(() => exit(answer.code ?? 0, null), 0);
      });
      return child;
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const hostsJson = (host: string, entries: object[]) =>
  JSON.stringify({ hosts: { [host]: entries } });
const EMPTY = '{"hosts":{}}';

describe("parseGhAuthStatusJson", () => {
  it("names the active account, wherever it is listed, and every login", () => {
    const out = hostsJson("github.com", [
      { state: "success", active: false, login: "old-me" },
      { state: "success", active: true, login: "octocat" },
      { state: "success", active: false, login: "bot" },
    ]);
    expect(parseGhAuthStatusJson(out, "github.com")).toEqual({
      ok: true,
      signedIn: true,
      account: "octocat",
      accounts: ["old-me", "octocat", "bot"],
    });
  });

  it("still names an active account whose stored token GitHub refuses", () => {
    const out = hostsJson("github.com", [
      { state: "error", active: false, login: "inactive" },
      { state: "error", active: true, login: "octocat" },
    ]);
    expect(parseGhAuthStatusJson(out, "github.com")).toMatchObject({ account: "octocat" });
  });

  it("reads an empty host list as not signed in", () => {
    expect(parseGhAuthStatusJson(EMPTY, "github.com")).toEqual({ ok: true, signedIn: false });
  });

  it("finds the requested host among others", () => {
    const out = JSON.stringify({
      hosts: {
        "ghe.example.com": [{ active: true, login: "corp" }],
        "github.com": [{ active: true, login: "octocat" }],
      },
    });
    expect(parseGhAuthStatusJson(out, "github.com")).toMatchObject({ account: "octocat" });
    expect(parseGhAuthStatusJson(out, "other.example.com")).toEqual({ ok: true, signedIn: false });
  });

  it("never shows a login that isn't one, or is shaped like a token", () => {
    for (const login of ["not a login", "a".repeat(101), TOKEN, "github_pat_11ABCDEF"]) {
      const out = hostsJson("github.com", [{ active: true, login }]);
      expect(parseGhAuthStatusJson(out, "github.com")).toEqual({
        ok: true,
        signedIn: true,
        account: null,
        accounts: [],
      });
    }
  });

  it("returns null for a host listed with entries it can't read", () => {
    expect(
      parseGhAuthStatusJson(hostsJson("github.com", [null as never]), "github.com")
    ).toBeNull();
    expect(parseGhAuthStatusJson('{"hosts":{"github.com":{}}}', "github.com")).toBeNull();
  });

  it("returns null for output that isn't the JSON shape", () => {
    expect(parseGhAuthStatusJson("github.com\n  ✓ Logged in", "github.com")).toBeNull();
    expect(parseGhAuthStatusJson('{"hosts":[]}', "github.com")).toBeNull();
    expect(parseGhAuthStatusJson("{}", "github.com")).toBeNull();
  });
});

describe("parseGhAuthStatusText", () => {
  it("reads the multi-account form and picks the active account", () => {
    const out = [
      "github.com",
      "  ✓ Logged in to github.com account octocat (keyring)",
      "  - Active account: true",
      "  ✓ Logged in to github.com account old-me (keyring)",
      "  - Active account: false",
    ].join("\n");
    expect(parseGhAuthStatusText(out, "github.com", 0)).toEqual({
      ok: true,
      signedIn: true,
      account: "octocat",
      accounts: ["octocat", "old-me"],
    });
  });

  it("reads the older single-account form for the requested host only", () => {
    const out = [
      "ghe.example.com",
      "  ✓ Logged in to ghe.example.com as corp (/home/u/.config/gh/hosts.yml)",
      "github.com",
      "  ✓ Logged in to github.com as octocat (/home/u/.config/gh/hosts.yml)",
    ].join("\n");
    expect(parseGhAuthStatusText(out, "github.com", 0)).toMatchObject({
      account: "octocat",
      accounts: ["octocat"],
    });
  });

  it.each([
    ["authentication failed", "  X github.com: authentication failed"],
    [
      "a token gh can no longer use",
      "  - The github.com token in /x/hosts.yml is no longer valid.",
    ],
    [
      "a token missing scopes",
      "  X github.com: the token in /x/hosts.yml is missing required scope 'read:org'",
    ],
  ])("treats an unnamed sign-in with %s as one to ask about", (_label, line) => {
    expect(parseGhAuthStatusText(`github.com\n${line}`, "github.com", 1)).toEqual({
      ok: true,
      signedIn: true,
      account: null,
      accounts: [],
    });
  });

  it("isn't fooled by a path that contains the signed-out words", () => {
    const out =
      "github.com\n  X github.com: authentication failed\n  - The github.com token in /home/u/not logged in/hosts.yml is no longer valid.";
    expect(parseGhAuthStatusText(out, "github.com", 1)).toMatchObject({ signedIn: true });
  });

  it("reads gh's signed-out diagnostics", () => {
    expect(
      parseGhAuthStatusText(
        "You are not logged into any GitHub hosts. To log in, run: gh auth login",
        "github.com",
        1
      )
    ).toEqual({ ok: true, signedIn: false });
    expect(
      parseGhAuthStatusText(
        'Hostname "ghe.example.com" not found among authenticated GitHub hosts',
        "ghe.example.com",
        1
      )
    ).toEqual({ ok: true, signedIn: false });
  });

  it("reads an unparseable successful status as an unnamed sign-in", () => {
    expect(parseGhAuthStatusText("github.com\n  ✓ something new", "github.com", 0)).toMatchObject({
      signedIn: true,
      account: null,
    });
  });

  it("fails on unrecognised output from a failed status", () => {
    expect(parseGhAuthStatusText("something broke", "github.com", 1)).toEqual({
      ok: false,
      reason: "cli-failed",
    });
  });
});

describe("readGhAccount", () => {
  it("asks for JSON without refreshing tokens", async () => {
    ghAnswers({ code: 0, stdout: hostsJson("ghe.example.com", [{ active: true, login: "corp" }]) });

    await expect(readGhAccount("ghe.example.com")).resolves.toMatchObject({ account: "corp" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual([
      "auth",
      "status",
      "--hostname",
      "ghe.example.com",
      "--no-refresh",
      "--json",
      "hosts",
    ]);
  });

  it.each(["--no-refresh", "--json"])(
    "falls back to the plain form on a gh without %s",
    async (flag) => {
      ghAnswers(
        { code: 1, stderr: `unknown flag: ${flag}\n\nUsage: ...` },
        { code: 0, stderr: "github.com\n  ✓ Logged in to github.com as octocat (oauth_token)" }
      );

      await expect(readGhAccount("github.com")).resolves.toMatchObject({ account: "octocat" });
      expect(spawned[1]!.args).toEqual(["auth", "status", "--hostname", "github.com"]);
    }
  );

  it("doesn't fall back for another flag gh rejected", async () => {
    ghAnswers({ code: 1, stderr: "unknown flag: --hostname-typo" });

    await expect(readGhAccount("github.com")).resolves.toEqual({ ok: false, reason: "cli-failed" });
    expect(spawned).toHaveLength(1);
  });

  it("fails on any other non-zero exit without guessing", async () => {
    ghAnswers({ code: 1, stderr: "could not read config" });

    await expect(readGhAccount("github.com")).resolves.toEqual({ ok: false, reason: "cli-failed" });
    expect(spawned).toHaveLength(1);
  });

  it("reports a missing gh", async () => {
    ghAnswers({ spawnError: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });

    await expect(readGhAccount("github.com")).resolves.toEqual({
      ok: false,
      reason: "cli-not-found",
    });
  });

  it("survives a spawn that fails with no pipes, reporting only the error", async () => {
    ghAnswers({ noPipes: true });

    await expect(readGhAccount("github.com")).resolves.toEqual({ ok: false, reason: "cli-failed" });
  });

  it("gives gh an env without inherited tokens, tracing or forced colour", async () => {
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]) {
      vi.stubEnv(key, "inherited");
    }
    vi.stubEnv("GH_DEBUG", "api");
    vi.stubEnv("DEBUG", "1");
    vi.stubEnv("CLICOLOR_FORCE", "1");
    vi.stubEnv("GH_FORCE_TTY", "1");
    ghAnswers({ code: 0, stdout: EMPTY });

    await readGhAccount("github.com");

    const { env, stdio, shell } = spawned[0]!.opts;
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GH_DEBUG",
      "DEBUG",
      "CLICOLOR_FORCE",
      "GH_FORCE_TTY",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NO_COLOR).toBe("1");
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(shell).toBeUndefined();
    expect(spawned[0]!.cmd).toBe("/usr/local/bin/gh");
  });
});

describe("signInGhWithToken", () => {
  it("sends the token on stdin only, then configures git for the host", async () => {
    ghAnswers({ code: 0 }, { code: 0 });

    await expect(signInGhWithToken(TOKEN, "ghe.example.com")).resolves.toEqual({
      ok: true,
      gitConfigured: true,
    });

    expect(spawned.map((run) => run.args)).toEqual([
      ["auth", "login", "--hostname", "ghe.example.com", "--with-token"],
      ["auth", "setup-git", "--hostname", "ghe.example.com"],
    ]);
    expect(spawned[0]!.stdin).toBe(`${TOKEN}\n`);
    expect(spawned[1]!.stdin).toBe("");
    for (const run of spawned) {
      expect(run.args.join(" ")).not.toContain(TOKEN);
      expect(JSON.stringify(run.opts.env)).not.toContain(TOKEN);
    }
  });

  it("reports a refused token without anything gh printed", async () => {
    ghAnswers({ code: 1, stderr: `error validating token: HTTP 401: Bad credentials ${TOKEN}` });

    const result = await signInGhWithToken(TOKEN, "github.com");

    expect(result).toEqual({ ok: false, reason: "refused" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(spawned).toHaveLength(1);
  });

  it("doesn't blame the token for a failure gh didn't pin on it", async () => {
    ghAnswers({ code: 1, stderr: "failed to write config: permission denied" });

    await expect(signInGhWithToken(TOKEN, "github.com")).resolves.toEqual({
      ok: false,
      reason: "cli-failed",
    });
  });

  it.each([
    ["missing required scope 'read:org'", ["read:org"]],
    ["missing required scopes 'repo', 'read:org'", ["repo", "read:org"]],
  ])("names the scopes gh says the token lacks: %s", async (message, scopes) => {
    ghAnswers({ code: 1, stderr: `error validating token: ${message}` });

    await expect(signInGhWithToken(TOKEN, "github.com")).resolves.toEqual({
      ok: false,
      reason: "missing-scopes",
      missingScopes: scopes,
    });
  });

  it("passes on no scope name it doesn't know", async () => {
    ghAnswers({
      code: 1,
      stderr: "error validating token: missing required scope 'internal_only'",
    });

    const result = await signInGhWithToken(TOKEN, "github.com");

    expect(result).toEqual({ ok: false, reason: "refused" });
    expect(JSON.stringify(result)).not.toContain("internal_only");
  });

  it("keeps the sign-in when setup-git fails", async () => {
    ghAnswers({ code: 0 }, { code: 1, stderr: "failed to set up git credential helper" });

    await expect(signInGhWithToken(TOKEN, "github.com")).resolves.toEqual({
      ok: true,
      gitConfigured: false,
    });
  });

  it("reports a missing gh before anything runs", async () => {
    lookupMock.resolveExecutableForSpawn.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { code: "ENOENT" })
    );

    await expect(signInGhWithToken(TOKEN, "github.com")).resolves.toEqual({
      ok: false,
      reason: "cli-not-found",
    });
    expect(spawned).toHaveLength(0);
  });

  it("reports a lookup that failed for another reason as a failure, not a missing gh", async () => {
    lookupMock.resolveExecutableForSpawn.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" })
    );

    await expect(signInGhWithToken(TOKEN, "github.com")).resolves.toEqual({
      ok: false,
      reason: "cli-failed",
    });
  });

  it("stops a login that doesn't finish, and kills it outright if it lingers", async () => {
    vi.useFakeTimers();
    ghAnswers({ hang: true, ignoreTerm: true });

    const pending = signInGhWithToken(TOKEN, "github.com");
    await vi.advanceTimersByTimeAsync(GH_LOGIN_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ ok: false, reason: "cli-timeout" });
    expect(spawned[0]!.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(GH_KILL_GRACE_MS);
    expect(spawned[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawned).toHaveLength(1);
  });
});

type Handler = PluginTypedIpcHandler<unknown, unknown>;

async function registered(settings: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const get = vi.fn(async (key: string) => settings[key]);
  const host = {
    registerHandler: vi.fn(async (channel: string, _schema: unknown, handler: Handler) => {
      handlers.set(channel, handler);
    }),
    settings: { get },
  } as unknown as PluginHostApi;
  const dispose = await registerGhSignIn(host);
  const call = <T>(channel: string, args: unknown) =>
    handlers.get(channel)!({} as never, args) as Promise<T>;
  return { dispose, call, get };
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const signedOut = { signedIn: false } as const;
const signedInAs = (account: string, accounts = [account]) => ({
  signedIn: true as const,
  account,
  accounts,
});

describe("registerGhSignIn", () => {
  it("signs gh in with the saved github.com token when the digest and gh's account match", async () => {
    storedMock.buildStoredCredentials.mockImplementation((id) =>
      id === "daintree.github.github" ? { kind: "bearer", value: TOKEN } : null
    );
    ghAnswers({ code: 0, stdout: EMPTY }, { code: 0 }, { code: 0 });
    const { call } = await registered();

    const result = await call<GhSignInResult>(GH_SIGN_IN_CHANNELS.signIn, {
      host: "github.com",
      tokenDigest: digest(TOKEN),
      expected: signedOut,
    });

    expect(result).toEqual({ ok: true, gitConfigured: true });
    expect(spawned[1]!.args).toEqual(["auth", "login", "--hostname", "github.com", "--with-token"]);
    expect(spawned[1]!.stdin).toBe(`${TOKEN}\n`);
  });

  it("reads the saved token with nothing awaited between the read and gh starting", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    const readsAtLookup: number[] = [];
    lookupMock.resolveExecutableForSpawn.mockImplementation(async () => {
      readsAtLookup.push(storedMock.buildStoredCredentials.mock.calls.length);
      return "/usr/local/bin/gh";
    });
    ghAnswers({ code: 0, stdout: EMPTY }, { code: 0 }, { code: 0 });
    const { call } = await registered();

    await call(GH_SIGN_IN_CHANNELS.signIn, {
      host: "github.com",
      tokenDigest: digest(TOKEN),
      expected: signedOut,
    });

    // gh is found once, before the token is read; a clear can't land between.
    expect(readsAtLookup).toEqual([0]);
    expect(storedMock.buildStoredCredentials).toHaveBeenCalledTimes(1);
  });

  it("refuses when the saved token is no longer the one the window saved", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: OTHER_TOKEN });
    ghAnswers({ code: 0, stdout: EMPTY });
    const { call } = await registered();

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "github.com",
        tokenDigest: digest(TOKEN),
        expected: signedOut,
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
    expect(spawned.some((run) => run.args.includes("login"))).toBe(false);
  });

  it("refuses when the token was cleared", async () => {
    storedMock.buildStoredCredentials.mockReturnValue(null);
    ghAnswers({ code: 0, stdout: EMPTY });
    const { call } = await registered();

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "github.com",
        tokenDigest: digest(TOKEN),
        expected: signedOut,
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
  });

  it.each([
    ["a sign-in appeared", signedOut, signedInAs("alice")],
    ["the active account changed", signedInAs("alice"), signedInAs("bob", ["alice", "bob"])],
    ["an account was added", signedInAs("alice"), signedInAs("alice", ["alice", "bob"])],
    ["the sign-in went away", signedInAs("alice"), signedOut],
  ])("asks again when %s after the person was shown gh's account", async (_label, shown, now) => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    const entries = now.signedIn
      ? now.accounts.map((login) => ({ login, active: login === now.account }))
      : [];
    ghAnswers({ code: 0, stdout: entries.length ? hostsJson("github.com", entries) : EMPTY });
    const { call } = await registered();

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "github.com",
        tokenDigest: digest(TOKEN),
        expected: shown,
      })
    ).resolves.toEqual({ ok: false, reason: "gh-changed", current: now });
    expect(spawned).toHaveLength(1);
  });

  it("matches an account the person confirmed regardless of case", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    ghAnswers(
      { code: 0, stdout: hostsJson("github.com", [{ active: true, login: "OctoCat" }]) },
      { code: 0 },
      { code: 0 }
    );
    const { call } = await registered();

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "github.com",
        tokenDigest: digest(TOKEN),
        expected: signedInAs("octocat"),
      })
    ).resolves.toEqual({ ok: true, gitConfigured: true });
  });

  it("uses the Enterprise Server record saved for the configured host", async () => {
    setEnterpriseHost("ghe.example.com");
    ghAnswers({ code: 0, stdout: EMPTY }, { code: 0 }, { code: 0 });
    const { call } = await registered({
      enterpriseToken: JSON.stringify({ version: 1, host: "ghe.example.com", token: TOKEN }),
    });

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "ghe.example.com",
        tokenDigest: digest(TOKEN),
        expected: signedOut,
      })
    ).resolves.toEqual({ ok: true, gitConfigured: true });
    expect(spawned[1]!.args).toEqual([
      "auth",
      "login",
      "--hostname",
      "ghe.example.com",
      "--with-token",
    ]);
    expect(spawned[1]!.stdin).toBe(`${TOKEN}\n`);
    expect(storedMock.buildStoredCredentials).not.toHaveBeenCalled();
  });

  it("refuses an Enterprise Server record saved for another host", async () => {
    setEnterpriseHost("ghe.example.com");
    ghAnswers({ code: 0, stdout: EMPTY });
    const { call } = await registered({
      enterpriseToken: JSON.stringify({ version: 1, host: "old.example.com", token: TOKEN }),
    });

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "ghe.example.com",
        tokenDigest: digest(TOKEN),
        expected: signedOut,
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
    expect(spawned.some((run) => run.args.includes("login"))).toBe(false);
  });

  it("refuses when the Enterprise Server host changes while its record is read", async () => {
    setEnterpriseHost("ghe.example.com");
    ghAnswers({ code: 0, stdout: EMPTY });
    const { call, get } = await registered();
    get.mockImplementation(async () => {
      setEnterpriseHost("other.example.com");
      return JSON.stringify({ version: 1, host: "ghe.example.com", token: TOKEN });
    });

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "ghe.example.com",
        tokenDigest: digest(TOKEN),
        expected: signedOut,
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
    expect(spawned.some((run) => run.args.includes("login"))).toBe(false);
  });

  it("answers only a host Daintree serves", async () => {
    setEnterpriseHost("ghe.example.com");
    ghAnswers({ code: 0, stdout: EMPTY });
    const { call } = await registered();

    await expect(call(GH_SIGN_IN_CHANNELS.status, { host: "ghe.example.com" })).resolves.toEqual({
      ok: true,
      signedIn: false,
    });
    await expect(call(GH_SIGN_IN_CHANNELS.status, { host: "evil.example.com" })).resolves.toEqual({
      ok: false,
      reason: "cli-failed",
    });
    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "evil.example.com",
        tokenDigest: digest(TOKEN),
        expected: signedOut,
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
    expect(spawned).toHaveLength(1);
  });

  it("returns a fixed reason when reading the saved token throws", async () => {
    storedMock.buildStoredCredentials.mockImplementation(() => {
      throw new Error(`EACCES reading ${TOKEN}`);
    });
    ghAnswers({ code: 0, stdout: EMPTY });
    const { call } = await registered();

    const result = await call(GH_SIGN_IN_CHANNELS.signIn, {
      host: "github.com",
      tokenDigest: digest(TOKEN),
      expected: signedOut,
    });

    expect(result).toEqual({ ok: false, reason: "cli-failed" });
  });

  it("runs one sign-in at a time", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    const { call } = await registered();
    ghAnswers(
      { code: 0, stdout: EMPTY },
      { code: 0 },
      { hang: true },
      { code: 0, stdout: hostsJson("github.com", [{ active: true, login: "octocat" }]) }
    );
    const args = { host: "github.com", tokenDigest: digest(TOKEN), expected: signedOut };

    const first = call<GhSignInResult>(GH_SIGN_IN_CHANNELS.signIn, args);
    const second = call<GhSignInResult>(GH_SIGN_IN_CHANNELS.signIn, args);
    await vi.waitFor(() => expect(spawned).toHaveLength(3));
    // The first is still in setup-git: the second hasn't started its status read.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned).toHaveLength(3);

    // Let setup-git finish by ending its run the way a real exit would.
    const setupChild = childProcessMock.spawn.mock.results[2]!.value as FakeChild;
    setupChild.exitCode = 0;
    setupChild.emit("close", 0);

    await expect(first).resolves.toEqual({ ok: true, gitConfigured: true });
    // The second saw the first's sign-in, which nobody was asked about.
    await expect(second).resolves.toMatchObject({ ok: false, reason: "gh-changed" });
  });

  it("kills a live run on dispose, and starts nothing queued after it", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    ghAnswers({ code: 0, stdout: EMPTY }, { hang: true });
    const { call, dispose } = await registered();
    const args = { host: "github.com", tokenDigest: digest(TOKEN), expected: signedOut };

    const live = call(GH_SIGN_IN_CHANNELS.signIn, args);
    const queued = call(GH_SIGN_IN_CHANNELS.signIn, args);
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(spawned[1]!.args).toContain("login");
    dispose();

    await expect(live).resolves.toEqual({ ok: false, reason: "cancelled" });
    await expect(queued).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(spawned[1]!.kills).toEqual(["SIGTERM"]);
    expect(spawned).toHaveLength(2);
  });
});
