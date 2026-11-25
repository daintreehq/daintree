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
  buildStoredCredentials: vi.fn<() => { kind: "bearer"; value: string } | null>(() => null),
}));
vi.mock("../../../../../electron/services/forge/forgeCredentialUtils.js", () => storedMock);

import {
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
  /** Never exits until killed by its abort signal. */
  hang?: boolean;
  /** Fails to start, like a missing binary. */
  spawnError?: NodeJS.ErrnoException;
}

interface SpawnRecord {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
}

const spawned: SpawnRecord[] = [];
let answers: Array<GhAnswer | ((args: string[]) => GhAnswer)> = [];

function ghAnswers(...next: Array<GhAnswer | ((args: string[]) => GhAnswer)>) {
  answers = next;
}

beforeEach(() => {
  vi.clearAllMocks();
  spawned.length = 0;
  answers = [];
  setEnterpriseHost(null);
  childProcessMock.spawn.mockImplementation(
    (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; signal: AbortSignal }) => {
      const record: SpawnRecord = { cmd, args, env: opts.env, stdin: "" };
      spawned.push(record);
      const next = answers.shift() ?? { code: 0 };
      const answer = typeof next === "function" ? next(args) : next;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: Writable;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          record.stdin += String(chunk);
          callback();
        },
      });
      if (answer.spawnError) {
        queueMicrotask(() => {
          child.emit("error", answer.spawnError);
          child.emit("close", null);
        });
        return child;
      }
      opts.signal.addEventListener("abort", () => {
        child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
        child.emit("close", null);
      });
      if (answer.hang) return child;
      child.stdin.once("finish", () => {
        child.stdout.end(answer.stdout ?? "");
        child.stderr.end(answer.stderr ?? "");
        setTimeout(() => child.emit("close", answer.code ?? 0), 0);
      });
      return child;
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const hostsJson = (host: string, entries: object[]) =>
  JSON.stringify({ hosts: { [host]: entries } });

describe("parseGhAuthStatusJson", () => {
  it("names the active account when gh holds several", () => {
    const out = hostsJson("github.com", [
      { state: "success", active: false, host: "github.com", login: "old-me" },
      { state: "success", active: true, host: "github.com", login: "octocat" },
    ]);
    expect(parseGhAuthStatusJson(out, "github.com")).toEqual({
      ok: true,
      signedIn: true,
      account: "octocat",
    });
  });

  it("still names an account whose stored token GitHub refuses", () => {
    const out = hostsJson("github.com", [{ state: "error", active: true, login: "octocat" }]);
    expect(parseGhAuthStatusJson(out, "github.com")).toMatchObject({ account: "octocat" });
  });

  it("reads an empty host list as not signed in", () => {
    expect(parseGhAuthStatusJson('{"hosts":{}}', "github.com")).toEqual({
      ok: true,
      signedIn: false,
    });
  });

  it("ignores other hosts", () => {
    const out = hostsJson("ghe.example.com", [{ active: true, login: "corp" }]);
    expect(parseGhAuthStatusJson(out, "github.com")).toEqual({ ok: true, signedIn: false });
  });

  it("leaves an account it can't read unnamed rather than echoing it", () => {
    const out = hostsJson("github.com", [{ active: true, login: "not a login\nX" }]);
    expect(parseGhAuthStatusJson(out, "github.com")).toEqual({
      ok: true,
      signedIn: true,
      account: null,
    });
  });

  it("returns null for output that isn't the JSON shape", () => {
    expect(parseGhAuthStatusJson("github.com\n  ✓ Logged in", "github.com")).toBeNull();
  });
});

describe("parseGhAuthStatusText", () => {
  it("reads the multi-account form and picks the active account", () => {
    const out = [
      "github.com",
      "  ✓ Logged in to github.com account old-me (keyring)",
      "  - Active account: false",
      "  ✓ Logged in to github.com account octocat (keyring)",
      "  - Active account: true",
    ].join("\n");
    expect(parseGhAuthStatusText(out, "github.com", 0)).toEqual({
      ok: true,
      signedIn: true,
      account: "octocat",
    });
  });

  it("reads the older single-account form", () => {
    const out = "github.com\n  ✓ Logged in to github.com as octocat (/home/u/.config/gh/hosts.yml)";
    expect(parseGhAuthStatusText(out, "github.com", 0)).toMatchObject({ account: "octocat" });
  });

  it("treats an unnamed failed sign-in as one to ask about", () => {
    const out =
      "github.com\n  X github.com: authentication failed\n  - The github.com token in /x is no longer valid.";
    expect(parseGhAuthStatusText(out, "github.com", 1)).toEqual({
      ok: true,
      signedIn: true,
      account: null,
    });
  });

  it("reads the not-signed-in diagnostics", () => {
    expect(
      parseGhAuthStatusText("You are not logged into any GitHub hosts.", "github.com", 1)
    ).toEqual({ ok: true, signedIn: false });
    expect(
      parseGhAuthStatusText(
        'Hostname "ghe.example.com" not found among authenticated GitHub hosts',
        "ghe.example.com",
        1
      )
    ).toEqual({ ok: true, signedIn: false });
  });

  it("fails on output it doesn't recognise", () => {
    expect(parseGhAuthStatusText("something broke", "github.com", 1)).toEqual({
      ok: false,
      reason: "cli-failed",
    });
  });
});

describe("readGhAccount", () => {
  it("asks for JSON without refreshing tokens", async () => {
    ghAnswers({ code: 0, stdout: hostsJson("github.com", [{ active: true, login: "octocat" }]) });

    await expect(readGhAccount("github.com")).resolves.toMatchObject({ account: "octocat" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual([
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--no-refresh",
      "--json",
      "hosts",
    ]);
  });

  it("falls back to the plain form on a gh without those flags", async () => {
    ghAnswers(
      { code: 1, stderr: "unknown flag: --no-refresh\n\nUsage: ..." },
      { code: 0, stderr: "github.com\n  ✓ Logged in to github.com as octocat (oauth_token)" }
    );

    await expect(readGhAccount("github.com")).resolves.toMatchObject({ account: "octocat" });
    expect(spawned[1]!.args).toEqual(["auth", "status", "--hostname", "github.com"]);
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

  it("strips inherited tokens so gh reports its own sign-in", async () => {
    vi.stubEnv("GH_TOKEN", "inherited");
    try {
      ghAnswers({ code: 0, stdout: '{"hosts":{}}' });
      await readGhAccount("github.com");
      expect(spawned[0]!.env.GH_TOKEN).toBeUndefined();
      expect(spawned[0]!.env.GH_PROMPT_DISABLED).toBe("1");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("signInGhWithToken", () => {
  it("sends the token on stdin only, then configures git for the host", async () => {
    ghAnswers({ code: 0 }, { code: 0 });

    await expect(signInGhWithToken(TOKEN, "github.com")).resolves.toEqual({
      ok: true,
      gitConfigured: true,
    });

    expect(spawned.map((run) => run.args)).toEqual([
      ["auth", "login", "--hostname", "github.com", "--with-token"],
      ["auth", "setup-git", "--hostname", "github.com"],
    ]);
    expect(spawned[0]!.stdin).toBe(`${TOKEN}\n`);
    expect(spawned[1]!.stdin).toBe("");
    for (const run of spawned) {
      expect(run.args.join(" ")).not.toContain(TOKEN);
      expect(JSON.stringify(run.env)).not.toContain(TOKEN);
    }
  });

  it("reports a refused token without anything gh printed", async () => {
    ghAnswers({ code: 1, stderr: `error validating token: HTTP 401: Bad credentials ${TOKEN}` });

    const result = await signInGhWithToken(TOKEN, "github.com");

    expect(result).toEqual({ ok: false, reason: "refused" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(spawned).toHaveLength(1);
  });

  it("names the scopes gh says the token lacks", async () => {
    ghAnswers({
      code: 1,
      stderr: "error validating token: missing required scopes 'repo', 'read:org'",
    });

    await expect(signInGhWithToken(TOKEN, "github.com")).resolves.toEqual({
      ok: false,
      reason: "missing-scopes",
      missingScopes: ["repo", "read:org"],
    });
  });

  it("keeps the sign-in when setup-git fails", async () => {
    ghAnswers({ code: 0 }, { code: 1, stderr: "failed to set up git credential helper" });

    await expect(signInGhWithToken(TOKEN, "ghe.example.com")).resolves.toEqual({
      ok: true,
      gitConfigured: false,
    });
    expect(spawned[1]!.args).toEqual(["auth", "setup-git", "--hostname", "ghe.example.com"]);
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

  it("kills a login that doesn't finish and reports the timeout", async () => {
    vi.useFakeTimers();
    ghAnswers({ hang: true });

    const pending = signInGhWithToken(TOKEN, "github.com");
    await vi.advanceTimersByTimeAsync(GH_LOGIN_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ ok: false, reason: "cli-timeout" });
    expect(spawned).toHaveLength(1);
  });
});

type Handler = PluginTypedIpcHandler<unknown, unknown>;

async function registered(settings: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const host = {
    registerHandler: vi.fn(async (channel: string, _schema: unknown, handler: Handler) => {
      handlers.set(channel, handler);
    }),
    settings: { get: vi.fn(async (key: string) => settings[key]) },
  } as unknown as PluginHostApi;
  const dispose = await registerGhSignIn(host);
  const call = <T>(channel: string, args: unknown) =>
    handlers.get(channel)!({} as never, args) as Promise<T>;
  return { dispose, call };
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const EMPTY = '{"hosts":{}}';

describe("registerGhSignIn", () => {
  it("signs gh in with the saved token when the digest and gh's account match", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    ghAnswers({ code: 0, stdout: EMPTY }, { code: 0 }, { code: 0 });
    const { call } = await registered();

    const result = await call<GhSignInResult>(GH_SIGN_IN_CHANNELS.signIn, {
      host: "github.com",
      tokenDigest: digest(TOKEN),
      expected: { signedIn: false },
    });

    expect(result).toEqual({ ok: true, gitConfigured: true });
    expect(spawned[1]!.args).toContain("login");
    expect(spawned[1]!.stdin).toBe(`${TOKEN}\n`);
  });

  it("refuses when the saved token is no longer the one the window saved", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: OTHER_TOKEN });
    ghAnswers({ code: 0, stdout: EMPTY });
    const { call } = await registered();

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "github.com",
        tokenDigest: digest(TOKEN),
        expected: { signedIn: false },
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
    expect(spawned.some((run) => run.args.includes("login"))).toBe(false);
  });

  it("asks again when gh's account changed after the person was shown it", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    ghAnswers({ code: 0, stdout: hostsJson("github.com", [{ active: true, login: "alice" }]) });
    const { call } = await registered();

    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "github.com",
        tokenDigest: digest(TOKEN),
        expected: { signedIn: false },
      })
    ).resolves.toEqual({
      ok: false,
      reason: "gh-changed",
      current: { signedIn: true, account: "alice" },
    });
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
        expected: { signedIn: true, account: "octocat" },
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
        expected: { signedIn: false },
      })
    ).resolves.toEqual({ ok: true, gitConfigured: true });
    expect(spawned[1]!.args).toEqual([
      "auth",
      "login",
      "--hostname",
      "ghe.example.com",
      "--with-token",
    ]);
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
        expected: { signedIn: false },
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
  });

  it("never touches gh for a host Daintree doesn't serve", async () => {
    const { call } = await registered();

    await expect(call(GH_SIGN_IN_CHANNELS.status, { host: "evil.example.com" })).resolves.toEqual({
      ok: false,
      reason: "cli-failed",
    });
    await expect(
      call(GH_SIGN_IN_CHANNELS.signIn, {
        host: "evil.example.com",
        tokenDigest: digest(TOKEN),
        expected: { signedIn: false },
      })
    ).resolves.toEqual({ ok: false, reason: "token-changed" });
    expect(spawned).toHaveLength(0);
  });

  it("runs one sign-in at a time", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    const { call } = await registered();
    ghAnswers(
      { code: 0, stdout: EMPTY },
      { code: 0 },
      { code: 0 },
      { code: 0, stdout: hostsJson("github.com", [{ active: true, login: "octocat" }]) }
    );
    const args = { host: "github.com", tokenDigest: digest(TOKEN), expected: { signedIn: false } };

    const [first, second] = await Promise.all([
      call<GhSignInResult>(GH_SIGN_IN_CHANNELS.signIn, args),
      call<GhSignInResult>(GH_SIGN_IN_CHANNELS.signIn, args),
    ]);

    expect(first).toEqual({ ok: true, gitConfigured: true });
    // The second saw the first's sign-in, which nobody was asked about.
    expect(second).toMatchObject({ ok: false, reason: "gh-changed" });
  });

  it("kills a live run on dispose", async () => {
    storedMock.buildStoredCredentials.mockReturnValue({ kind: "bearer", value: TOKEN });
    ghAnswers({ hang: true });
    const { call, dispose } = await registered();

    const pending = call(GH_SIGN_IN_CHANNELS.signIn, {
      host: "github.com",
      tokenDigest: digest(TOKEN),
      expected: { signedIn: false },
    });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    dispose();

    await expect(pending).resolves.toEqual({ ok: false, reason: "cancelled" });
  });
});
