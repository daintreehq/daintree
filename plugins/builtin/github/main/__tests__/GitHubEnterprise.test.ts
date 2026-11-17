import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliMock = vi.hoisted(() => ({
  previewGhCredential: vi.fn(),
  commitGhCredential: vi.fn(),
}));
vi.mock("../GitHubCliCredential.js", () => cliMock);

import { GitHubAuth } from "../GitHubAuth.js";
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

    await account.load();

    expect(getEnterpriseHost()).toBe(GHES);
    expect(GitHubAuth.getToken(GHES)).toBe("enterprise-token");
    expect(GitHubAuth.getToken()).toBeUndefined();
    expect(onCredentialsChanged).toHaveBeenCalledTimes(1);
  });

  it("never uses a token saved for another host, and reports it as stale", async () => {
    const { account } = makeAccount({
      enterpriseHost: "ghe.new.example",
      enterpriseToken: record("ghe.old.example", "old-token"),
    });

    await account.load();

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
    await account.load();

    await expect(account.setHost("ghe.other.example")).resolves.toEqual({
      ok: true,
      host: "ghe.other.example",
    });

    expect(values.get("enterpriseHost")).toBe("ghe.other.example");
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
    expect(GitHubAuth.getToken("ghe.other.example")).toBeUndefined();
    // Back to the original host: its saved record applies again.
    await account.setHost(GHES);
    expect(GitHubAuth.getToken(GHES)).toBe("enterprise-token");
  });

  it("refuses a host that isn't a bare hostname, and clears it when empty", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await account.load();

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
    await account.load();
    const validate = vi.spyOn(GitHubAuth, "validate").mockResolvedValue({
      valid: true,
      scopes: ["repo"],
      username: "mona",
    });

    await expect(account.saveToken(" enterprise-token ")).resolves.toEqual({
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
    await account.load();
    vi.spyOn(GitHubAuth, "validate").mockResolvedValue({
      valid: false,
      scopes: [],
      error: "Invalid or expired token",
    });

    await expect(account.saveToken("bad")).resolves.toMatchObject({ valid: false });
    expect(values.has("enterpriseToken")).toBe(false);
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
  });

  it("stores nothing when the host changed while the token was checked", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await account.load();
    vi.spyOn(GitHubAuth, "validate").mockImplementation(async () => {
      await account.setHost("ghe.other.example");
      return { valid: true, scopes: [], username: "mona" };
    });

    await expect(account.saveToken("enterprise-token")).resolves.toMatchObject({ valid: false });
    expect(values.has("enterpriseToken")).toBe(false);
  });

  it("refuses token work until a host is set", async () => {
    const { account } = makeAccount();
    await account.load();

    await expect(account.saveToken("t")).resolves.toMatchObject({ valid: false });
    await expect(account.previewImport()).resolves.toEqual({ ok: false, reason: "no-host" });
  });

  it("clears the saved token and empties the session", async () => {
    const { account, values } = makeAccount({
      enterpriseHost: GHES,
      enterpriseToken: record(GHES, "enterprise-token"),
    });
    await account.load();

    await account.clearToken();

    expect(values.has("enterpriseToken")).toBe(false);
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
  });

  it("imports gh's token for the configured host and refuses one previewed for another", async () => {
    const { account, values } = makeAccount({ enterpriseHost: GHES });
    await account.load();
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
    await account.load();

    account.dispose();

    expect(getEnterpriseHost()).toBeNull();
    expect(GitHubAuth.getToken(GHES)).toBeUndefined();
  });
});
