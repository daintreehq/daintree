import { describe, it, expect } from "vitest";
import {
  carriesPoolStrippedEnv,
  computePoolEnvHash,
  POOL_ENV_EMPTY_HASH,
  VOLATILE_ENV_KEYS,
} from "../ptyPoolEnvHash.js";
import { filterSensitiveOnly } from "../EnvironmentFilter.js";

describe("computePoolEnvHash", () => {
  it("returns the empty sentinel for undefined input", () => {
    expect(computePoolEnvHash(undefined)).toBe(POOL_ENV_EMPTY_HASH);
  });

  it("returns the empty sentinel for an empty object", () => {
    expect(computePoolEnvHash({})).toBe(POOL_ENV_EMPTY_HASH);
  });

  it("is deterministic across object key order", () => {
    const a = computePoolEnvHash({ FOO: "1", BAR: "2", BAZ: "3" });
    const b = computePoolEnvHash({ BAZ: "3", FOO: "1", BAR: "2" });
    const c = computePoolEnvHash({ BAR: "2", BAZ: "3", FOO: "1" });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("produces different hashes for different values", () => {
    const a = computePoolEnvHash({ FOO: "1" });
    const b = computePoolEnvHash({ FOO: "2" });
    expect(a).not.toBe(b);
  });

  it("produces different hashes for different keys", () => {
    const a = computePoolEnvHash({ FOO: "1" });
    const b = computePoolEnvHash({ BAR: "1" });
    expect(a).not.toBe(b);
  });

  it("excludes volatile shell-state keys from the hash", () => {
    const base = computePoolEnvHash({ FOO: "1" });
    for (const key of VOLATILE_ENV_KEYS) {
      const withVolatile = computePoolEnvHash({ FOO: "1", [key]: "anything" });
      expect(withVolatile).toBe(base);
    }
  });

  it("returns the empty sentinel when input contains only volatile keys", () => {
    const onlyVolatile: Record<string, string> = {};
    for (const key of VOLATILE_ENV_KEYS) {
      onlyVolatile[key] = "x";
    }
    expect(computePoolEnvHash(onlyVolatile)).toBe(POOL_ENV_EMPTY_HASH);
  });

  it("excludes sensitive secret keys via filterEnvironment", () => {
    const a = computePoolEnvHash({ FOO: "1" });
    const b = computePoolEnvHash({
      FOO: "1",
      ANTHROPIC_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp-x",
      MY_SERVICE_TOKEN: "y",
    });
    expect(b).toBe(a);
  });

  it("returns the empty sentinel for env containing only secrets", () => {
    expect(computePoolEnvHash({ ANTHROPIC_API_KEY: "x", DATABASE_URL: "postgres://" })).toBe(
      POOL_ENV_EMPTY_HASH
    );
  });

  it("excludes auto-injected DAINTREE_* metadata vars (they're overwritten fresh per spawn)", () => {
    const base = computePoolEnvHash({ FOO: "1" });
    const withMetadata = computePoolEnvHash({
      FOO: "1",
      DAINTREE_PANE_ID: "abc",
      DAINTREE_CWD: "/repo",
      DAINTREE_PROJECT_ID: "proj-1",
      DAINTREE_WORKTREE_ID: "wt-1",
    });
    expect(withMetadata).toBe(base);
  });

  it("DOES distinguish on caller-supplied DAINTREE_* keys outside the auto-injected set", () => {
    // Caller-supplied DAINTREE_E2E_AGENT_COLOR (e.g. agent preset metadata)
    // reaches the child intact, so the pool slot must key on it — otherwise
    // a slot warmed for caller A would be served to caller B whose preset
    // intentionally set a different value (#7625 family regression).
    const base = computePoolEnvHash({ FOO: "1" });
    const withCustom = computePoolEnvHash({
      FOO: "1",
      DAINTREE_E2E_AGENT_COLOR: "#3366ff",
    });
    expect(withCustom).not.toBe(base);
  });

  it("strips undefined values before hashing", () => {
    const a = computePoolEnvHash({ FOO: "1" });
    const b = computePoolEnvHash({ FOO: "1", BAR: undefined });
    expect(b).toBe(a);
  });

  it("is sensitive to value length without collisions on adjacent ASCII chars", () => {
    const a = computePoolEnvHash({ FOO: "ab" });
    const b = computePoolEnvHash({ FOO: "ba" });
    expect(a).not.toBe(b);
  });

  it("returns a hash with the env- prefix", () => {
    const hash = computePoolEnvHash({ FOO: "1", BAR: "2" });
    expect(hash).toMatch(/^env-/);
    expect(hash).not.toBe(POOL_ENV_EMPTY_HASH);
  });
});

describe("carriesPoolStrippedEnv", () => {
  it("is false for missing or empty env", () => {
    expect(carriesPoolStrippedEnv(undefined)).toBe(false);
    expect(carriesPoolStrippedEnv({})).toBe(false);
  });

  it("flags secret-named variables whether matched by exact name or by pattern", () => {
    expect(carriesPoolStrippedEnv({ FOO: "1", ANTHROPIC_API_KEY: "sk" })).toBe(true);
    expect(carriesPoolStrippedEnv({ DAINTREE_MCP_TOKEN: "t" })).toBe(true);
    expect(carriesPoolStrippedEnv({ my_service_token: "t" })).toBe(true);
  });

  it("ignores undefined values, which never reach the spawned shell", () => {
    expect(carriesPoolStrippedEnv({ FOO: "1", GITHUB_TOKEN: undefined })).toBe(false);
  });

  it("does not flag names that merely contain a sensitive word mid-token", () => {
    expect(carriesPoolStrippedEnv({ TOKENIZER_PATH: "/x", DAINTREE_E2E_AGENT_COLOR: "#fff" })).toBe(
      false
    );
  });

  it("agrees with the pool's filter: false exactly when filtering drops no defined key", () => {
    const samples: Array<Record<string, string | undefined>> = [
      { FOO: "1" },
      { FOO: "1", GITHUB_TOKEN: "x" },
      { DATABASE_URL: "postgres://" },
      { TOKENIZER_PATH: "/x", EMPTY: undefined },
      { MY_CLIENT_SECRET: "s", PATH: "/usr/bin" },
    ];
    for (const env of samples) {
      const definedKeys = Object.keys(env).filter((key) => env[key] !== undefined);
      const keptAll = Object.keys(filterSensitiveOnly(env)).length === definedKeys.length;
      expect(carriesPoolStrippedEnv(env)).toBe(!keptAll);
    }
  });
});
