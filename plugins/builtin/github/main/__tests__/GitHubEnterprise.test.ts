import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliMock = vi.hoisted(() => ({
  previewGhCredential: vi.fn(),
  commitGhCredential: vi.fn(),
}));
vi.mock("../GitHubCliCredential.js", () => cliMock);

import { GitHubAuth } from "../GitHubAuth.js";
import { repoStatsCache } from "../GitHubCaches.js";
import { _resetEnterpriseHostForTests, getEnterpriseHost } from "../GitHubHost.js";
import {
  GitHubEnterpriseAccount,
  parseEnterpriseTokenRecord,
  type EnterpriseSettingsAccess,
} from "../GitHubEnterprise.js";

const GHES = "github.example.com";

function makeSettings(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const settings: EnterpriseSettingsAccess = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    unset: async (key) => {
      values.delete(key);
    },
  };
  return { settings, values };
}

function record(host: string, token: string): string {
  return JSON.stringify({ version: 1, host, token });
}

async function load(account: GitHubEnterpriseAccount): Promise<void> {
  await account.loadHost();
  await account.applySession();
}

// Valid in shape, so a refusal can't be the token format's doing.
const CANDIDATE = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

function makeAccount(initial: Record<string, unknown> = {}) {
  const { settings, values } = makeSettings(initial);
  const onCredentialsChanged = vi.fn();
  const account = new GitHubEnterpriseAccount({ settings, onCredentialsChanged });
  return { account, values, onCredentialsChanged };
}

beforeEach(() => {
  GitHubAuth._resetSessionsForTests();
  _resetEnterpriseHostForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  GitHubAuth._resetSessionsForTests();
  _resetEnterpriseHostForTests();
});

describe("parseEnterpriseTokenRecord", () => {
  it("reads a record bound to a host", () => {
    expect(parseEnterpriseTokenRecord(record(GHES, " tok "))).toEqual({
      version: 1,
      host: GHES,
      token: "tok",
    });
  });

  it.each([
    ["a bare token", "ghp_abc"],
    ["no host", JSON.stringify({ version: 1, token: "t" })],
    ["github.com as the host", record("github.com", "t")],
    ["a host that isn't canonical", record("GitHub.Example.com", "t")],
    ["an unknown version", JSON.stringify({ version: 2, host: GHES, token: "t" })],
  ])("refuses %s", (_label, raw) => {
    expect(parseEnterpriseTokenRecord(raw)).toBeNull();
  });
});

describe("GitHubEnterpriseAccount", () => {
  it("loads the saved token into the configured host's session, and only that host's", async () => {
    const { account, onCredentialsChanged } = makeAccount({
      enterpriseHost: GHES,
      enterpriseToken: record(GHES, "enterprise-token"),
    });

    await load(account);

    expect(getEnterpriseHost()).toBe(GHES);
    expect(GitHubAuth.getToken(GHES)).toBe("enterprise-token");
    expect(GitHubAuth.getToken()).toBeUndefined();
    expect(onCredentialsChanged).toHaveBeenCalledTimes(1);
  });

  it("restores the saved host and token at startup without dropping cached pages", async () => {
    repoStatsCache.set("team/app", { issueCount: 3, prCount: 1 });
    const { account } = makeAccount({
      enterpriseHost: GHES,
      enterpriseToken: record(GHES, "enterprise-token"),
    });

    await load(account);
    expect(repoStatsCache.get("team/app")).toEqual({ issueCount: 3, prCount: 1 });

    // An actual change of host is a change: what was fetched under the old
    // routing goes.
    await account.setHost("ghe.other.example");
    expect(repoStatsCache.get("team/app")).toBeUndefined();
  });

  it("never uses a token saved for another host, and reports it as stale", async () => {
    const { account } = makeAccount({
      enterpriseHost: "ghe.new.example",
      enterpriseToken: record("ghe.old.example", "old-token"),
    });

    await load(account);

    expect(GitHubAuth.getToken("ghe.new.example")).toBeUndefined();
    await expect(account.status()).resolves.toEqual({
      host: "ghe.new.example",
      hasToken: false,
      staleTokenHost: "ghe.old.example",
    });
  });

  it("retires the old host's session when the host changes", async () => {
    const { account, values } = makeAccount({
      enterpriseHost: GHES,
      enterpriseToken: record(GHES, "enterprise-token"),
    });
    await load(account);

    await expect(account.setHost("ghe.other.example")).resolves.toEqual({
      ok: true,
      host: "ghe.other.example",
    });

    expect(values.get("enterpriseHost")).toBe("ghe.other.example");
    // Removed from memory, not merely hidden because the host is unserved.
    expect(GitHubAuth.hostHoldingToken("enterprise-token")).toBeNull();
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
    expect(GitHubAuth.getToken("ghe.other.example")).toBeUndefined();
    // Back to the original host: its saved record applies again.
    await account.setHost(GHES);
    expect(GitHubAuth.getToken(GHES)).toBe("enterprise-token");
  });

  it("refuses a host that isn't a bare hostname, and clears it when empty", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await load(account);

    const refused = await account.setHost("https://github.example.com/team");
    expect(refused.ok).toBe(false);
    expect(values.get("enterpriseHost")).toBe(GHES);

    await expect(account.setHost("github.com")).resolves.toMatchObject({ ok: false });

    await expect(account.setHost("  ")).resolves.toEqual({ ok: true, host: null });
    expect(values.get("enterpriseHost")).toBe("");
    expect(getEnterpriseHost()).toBeNull();
  });

  it("saves a token only after the configured host accepts it, bound to that host", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await load(account);
    const validate = vi.spyOn(GitHubAuth, "validate").mockResolvedValue({
      valid: true,
      scopes: ["repo"],
      username: "mona",
    });

    await expect(account.saveToken(" enterprise-token ", GHES)).resolves.toEqual({
      valid: true,
      scopes: ["repo"],
      account: "mona",
    });

    expect(validate).toHaveBeenCalledWith("enterprise-token", { host: GHES, detached: true });
    expect(parseEnterpriseTokenRecord(values.get("enterpriseToken"))).toEqual({
      version: 1,
      host: GHES,
      token: "enterprise-token",
    });
    expect(GitHubAuth.getToken(GHES)).toBe("enterprise-token");
    expect(GitHubAuth.getConfig(GHES).username).toBe("mona");
  });

  it("stores nothing when the server rejects the token", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await load(account);
    vi.spyOn(GitHubAuth, "validate").mockResolvedValue({
      valid: false,
      scopes: [],
      error: "Invalid or expired token",
    });

    await expect(account.saveToken("bad", GHES)).resolves.toMatchObject({ valid: false });
    expect(values.has("enterpriseToken")).toBe(false);
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
  });

  it("stores nothing when the host changed while the token was checked", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await load(account);
    vi.spyOn(GitHubAuth, "validate").mockImplementation(async () => {
      await account.setHost("ghe.other.example");
      return { valid: true, scopes: [], username: "mona" };
    });

    await expect(account.saveToken("enterprise-token", GHES)).resolves.toMatchObject({
      valid: false,
    });
    expect(values.has("enterpriseToken")).toBe(false);
  });

  it("refuses a token meant for another host before it reaches any server", async () => {
    const { account } = makeAccount({ enterpriseHost: GHES });
    await load(account);
    const validate = vi.spyOn(GitHubAuth, "validate");

    // The form still shows the previous host; another window has moved on.
    await expect(account.testToken(CANDIDATE, "ghe.old.example")).resolves.toMatchObject({
      valid: false,
    });
    await expect(account.saveToken(CANDIDATE, "ghe.old.example")).resolves.toMatchObject({
      valid: false,
    });
    await expect(account.clearToken("ghe.old.example")).resolves.toEqual({ cleared: false });

    expect(validate).not.toHaveBeenCalled();
  });

  it("lets a clear that lands during a save's validation win", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await load(account);
    vi.spyOn(GitHubAuth, "validate").mockImplementation(async () => {
      await account.clearToken(GHES);
      return { valid: true, scopes: [], username: "mona" };
    });

    await expect(account.saveToken(CANDIDATE, GHES)).resolves.toMatchObject({ valid: false });
    expect(values.has("enterpriseToken")).toBe(false);
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
  });

  it("never uses a bare token typed into the generated settings form, which names no host", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES, enterpriseToken: CANDIDATE });

    await load(account);

    expect(GitHubAuth.hostHoldingToken(CANDIDATE)).toBeNull();
    expect(values.get("enterpriseToken")).toBe(CANDIDATE);
  });

  it("lets a clear from the generated settings form win over a save still validating", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await load(account);
    vi.spyOn(GitHubAuth, "validate").mockImplementation(async () => {
      // The token setting changed outside this account while the save checked.
      values.delete("enterpriseToken");
      account.onTokenSetting();
      return { valid: true, scopes: [], username: "mona" };
    });

    await expect(account.saveToken(CANDIDATE, GHES)).resolves.toMatchObject({ valid: false });
    expect(values.has("enterpriseToken")).toBe(false);
  });

  it("treats a host change during the startup token read as a change, not a restore", async () => {
    repoStatsCache.set("team/app", { issueCount: 3, prCount: 1 });
    let releaseRead: (value: unknown) => void = () => {};
    const { settings, values } = makeSettings({ enterpriseHost: GHES });
    const get = settings.get;
    settings.get = async (key) =>
      key === "enterpriseToken"
        ? new Promise((resolve) => {
            releaseRead = resolve;
          })
        : get(key);
    const account = new GitHubEnterpriseAccount({ settings, onCredentialsChanged: vi.fn() });
    await account.loadHost();
    const restore = account.applySession();

    values.set("enterpriseHost", "ghe.other.example");
    account.onHostSetting("ghe.other.example");
    releaseRead(undefined);
    await restore;

    expect(repoStatsCache.get("team/app")).toBeUndefined();
  });

  it("drops cached pages when the token is cleared before startup finished reading it", async () => {
    repoStatsCache.set("ghe.example/team/app", { issueCount: 3, prCount: 1 });
    const { account } = makeAccount({ enterpriseHost: GHES });
    await account.loadHost();

    account.onTokenSetting();

    expect(repoStatsCache.get("ghe.example/team/app")).toBeUndefined();
  });

  it("installs nothing when disposed while the startup token read is still pending", async () => {
    let releaseRead: (value: unknown) => void = () => {};
    const { settings } = makeSettings({ enterpriseHost: GHES });
    const get = settings.get;
    settings.get = async (key) =>
      key === "enterpriseToken"
        ? new Promise((resolve) => {
            releaseRead = resolve;
          })
        : get(key);
    const account = new GitHubEnterpriseAccount({ settings, onCredentialsChanged: vi.fn() });
    await account.loadHost();
    const restore = account.applySession();

    account.dispose();
    releaseRead(record(GHES, "enterprise-token"));
    await restore;

    expect(GitHubAuth.hostHoldingToken("enterprise-token")).toBeNull();
  });

  it("refuses token work until a host is set", async () => {
    const { account } = makeAccount();
    await load(account);

    const validate = vi.spyOn(GitHubAuth, "validate");
    await expect(account.saveToken(CANDIDATE, GHES)).resolves.toMatchObject({ valid: false });
    expect(validate).not.toHaveBeenCalled();
    await expect(account.previewImport()).resolves.toEqual({ ok: false, reason: "no-host" });
  });

  it("clears the saved token and empties the session", async () => {
    const { account, values } = makeAccount({
      enterpriseHost: GHES,
      enterpriseToken: record(GHES, "enterprise-token"),
    });
    await load(account);

    await expect(account.clearToken(GHES)).resolves.toEqual({ cleared: true });

    expect(values.has("enterpriseToken")).toBe(false);
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
  });

  it("imports gh's token for the configured host and refuses one previewed for another", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await load(account);
    cliMock.commitGhCredential.mockResolvedValue({
      credentials: { token: "gh-enterprise-token" },
      validation: { valid: true, scopes: ["repo"], account: "mona" },
    });

    await expect(
      account.commitImport({ account: "mona", host: "ghe.other.example" })
    ).resolves.toEqual({
      ok: false,
      reason: "host-changed",
    });
    expect(cliMock.commitGhCredential).not.toHaveBeenCalled();

    await expect(account.commitImport({ account: "mona", host: GHES })).resolves.toEqual({
      ok: true,
      account: "mona",
      scopes: ["repo"],
    });
    expect(cliMock.commitGhCredential).toHaveBeenCalledWith({ account: "mona" }, undefined, GHES);
    expect(parseEnterpriseTokenRecord(values.get("enterpriseToken"))?.token).toBe(
      "gh-enterprise-token"
    );
  });

  it("empties the session and forgets the host on dispose", async () => {
    const { account } = makeAccount({
      enterpriseHost: GHES,
      enterpriseToken: record(GHES, "enterprise-token"),
    });
    await load(account);

    account.dispose();

    expect(GitHubAuth.hostHoldingToken("enterprise-token")).toBeNull();
    expect(getEnterpriseHost()).toBeNull();
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
  });
});
