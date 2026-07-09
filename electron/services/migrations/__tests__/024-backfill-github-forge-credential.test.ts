import { beforeEach, describe, expect, it, vi } from "vitest";
import { migration024 } from "../024-backfill-github-forge-credential.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";

const LEGACY_KEY = "userConfig.githubToken";

/**
 * Flat key map — matches the dot-notated keys electron-store resolves for
 * `userConfig.githubToken`, mirroring `SecureStorage.test.ts`.
 */
function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
  } as unknown as Parameters<typeof migration024.up>[0];
}

function credentialsOf(data: Record<string, unknown>): Record<string, string> {
  return (data.forgeCredentials ?? {}) as Record<string, string>;
}

/** The token a reader would recover from the stored credential record. */
function storedToken(data: Record<string, unknown>): string | undefined {
  const raw = credentialsOf(data)[BUILTIN_GITHUB_PROVIDER_ID];
  if (typeof raw !== "string") return undefined;
  return (JSON.parse(raw) as { token?: string }).token;
}

describe("migration024 — backfill legacy GitHub token into forgeCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("backfills the legacy token and removes the legacy key", () => {
    const data: Record<string, unknown> = { [LEGACY_KEY]: "ghp_legacytoken" };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(storedToken(data)).toBe("ghp_legacytoken");
    expect(LEGACY_KEY in data).toBe(false);
  });

  it("merges into forgeCredentials without disturbing other providers", () => {
    const otherEntry = JSON.stringify({ token: "glpat_other" });
    const data: Record<string, unknown> = {
      [LEGACY_KEY]: "ghp_legacytoken",
      forgeCredentials: { "acme.gitlab": otherEntry },
    };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(credentialsOf(data)["acme.gitlab"]).toBe(otherEntry);
    expect(storedToken(data)).toBe("ghp_legacytoken");
  });

  it("keeps a post-cutover credential and still drops the stale legacy key", () => {
    // Closes the clear-token resurrection path: `forge:clear-credential` never
    // touched the legacy key, so leaving it would restore the old token on boot.
    const current = JSON.stringify({ token: "ghp_current" });
    const data: Record<string, unknown> = {
      [LEGACY_KEY]: "ghp_stale",
      forgeCredentials: { [BUILTIN_GITHUB_PROVIDER_ID]: current },
    };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(storedToken(data)).toBe("ghp_current");
    expect(LEGACY_KEY in data).toBe(false);
  });

  it("overwrites a destination entry that readers treat as absent", () => {
    // `recordHasCredential` rejects a blank value, so the panel gate would still
    // report "not connected" if the backfill deferred to this entry.
    const data: Record<string, unknown> = {
      [LEGACY_KEY]: "ghp_legacytoken",
      forgeCredentials: { [BUILTIN_GITHUB_PROVIDER_ID]: JSON.stringify({ token: "   " }) },
    };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(storedToken(data)).toBe("ghp_legacytoken");
  });

  it("overwrites a destination entry that is not parseable JSON", () => {
    const data: Record<string, unknown> = {
      [LEGACY_KEY]: "ghp_legacytoken",
      forgeCredentials: { [BUILTIN_GITHUB_PROVIDER_ID]: "not-json" },
    };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(storedToken(data)).toBe("ghp_legacytoken");
  });

  it("is replay-safe: a second run leaves the migrated state untouched", () => {
    const data: Record<string, unknown> = { [LEGACY_KEY]: "ghp_legacytoken" };
    const store = makeStoreMock(data);

    migration024.up(store);
    const afterFirst = { ...credentialsOf(data) };
    migration024.up(store);

    expect(credentialsOf(data)).toEqual(afterFirst);
    expect(LEGACY_KEY in data).toBe(false);
  });

  it("does nothing when there is no legacy token", () => {
    const data: Record<string, unknown> = { forgeCredentials: {} };
    const store = makeStoreMock(data);

    migration024.up(store);

    const { set, delete: del } = store as unknown as {
      set: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("drops a blank legacy token without writing a phantom credential", () => {
    const data: Record<string, unknown> = { [LEGACY_KEY]: "   " };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(data.forgeCredentials).toBeUndefined();
    expect(LEGACY_KEY in data).toBe(false);
  });

  it("warns and drops a corrupt non-string legacy token", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data: Record<string, unknown> = { [LEGACY_KEY]: { nested: "object" } };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(data.forgeCredentials).toBeUndefined();
    expect(LEGACY_KEY in data).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(LEGACY_KEY));
    warnSpy.mockRestore();
  });

  it("replaces a corrupt non-object forgeCredentials rather than throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data: Record<string, unknown> = {
      [LEGACY_KEY]: "ghp_legacytoken",
      forgeCredentials: "corrupt-string",
    };
    const store = makeStoreMock(data);

    expect(() => migration024.up(store)).not.toThrow();

    expect(storedToken(data)).toBe("ghp_legacytoken");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("forgeCredentials"));
    warnSpy.mockRestore();
  });

  it("trims surrounding whitespace off the migrated token", () => {
    const data: Record<string, unknown> = { [LEGACY_KEY]: "  ghp_legacytoken\n" };
    const store = makeStoreMock(data);

    migration024.up(store);

    expect(storedToken(data)).toBe("ghp_legacytoken");
  });

  it("clears the legacy key with delete, never set(key, undefined)", () => {
    // electron-store v11 throws on `set(key, undefined)` (#2727).
    const data: Record<string, unknown> = { [LEGACY_KEY]: "ghp_legacytoken" };
    const store = makeStoreMock(data);

    migration024.up(store);

    const { set, delete: del } = store as unknown as {
      set: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    expect(del).toHaveBeenCalledWith(LEGACY_KEY);
    expect(set).not.toHaveBeenCalledWith(LEGACY_KEY, undefined);
  });
});
