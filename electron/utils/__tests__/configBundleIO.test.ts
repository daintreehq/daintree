import { describe, expect, it } from "vitest";
import {
  buildConfigBundle,
  omitSecretValues,
  omitSectionSecrets,
  parseConfigBundle,
} from "../configBundleIO.js";
import {
  CONFIG_BUNDLE_MAX_BYTES,
  CONFIG_BUNDLE_SCHEMA_VERSION,
} from "../../../shared/types/configBundle.js";

const EXPORTED_AT = "2026-01-01T00:00:00.000Z";

/** Matches the generic `KEY=secret-looking-value` pattern in secretScrubber. */
const SECRETISH = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

describe("omitSecretValues", () => {
  it("drops the key holding a secret and keeps its siblings", () => {
    const { value, omitted } = omitSecretValues(
      { token: SECRETISH, name: "build agent" },
      "agentSettings"
    );

    expect(value).toEqual({ name: "build agent" });
    expect(omitted).toEqual(["agentSettings.token"]);
  });

  it("finds secrets under arbitrary nesting, not just known field names", () => {
    const { value, omitted } = omitSecretValues(
      {
        agents: {
          custom: {
            customPresets: [{ env: { ANYTHING_AT_ALL: SECRETISH, SAFE: "yes" } }],
          },
        },
      },
      "agentSettings"
    );

    expect(omitted).toEqual(["agentSettings.agents.custom.customPresets[0].env.ANYTHING_AT_ALL"]);
    expect(value).toEqual({
      agents: { custom: { customPresets: [{ env: { SAFE: "yes" } }] } },
    });
  });

  it("leaves non-string leaves untouched", () => {
    const input = { count: 3, enabled: false, missing: null };
    const { value, omitted } = omitSecretValues(input, "");
    expect(value).toEqual(input);
    expect(omitted).toEqual([]);
  });
});

describe("buildConfigBundle", () => {
  it("reports every section it actually wrote", () => {
    const { json, sections } = buildConfigBundle(
      {
        keybindingOverrides: { "app.settings": ["Cmd+,"] },
        worktreeConfig: { pathPattern: "../{n}" },
      },
      EXPORTED_AT
    );

    expect(sections.sort()).toEqual(["keybindingOverrides", "worktreeConfig"]);
    expect(Object.keys(JSON.parse(json).sections).sort()).toEqual([
      "keybindingOverrides",
      "worktreeConfig",
    ]);
  });

  it("skips sections whose value is undefined instead of writing a null hole", () => {
    const { json, sections } = buildConfigBundle(
      { appTheme: undefined, worktreeConfig: { pathPattern: "../{n}" } },
      EXPORTED_AT
    );

    expect(sections).toEqual(["worktreeConfig"]);
    expect(JSON.parse(json).sections).not.toHaveProperty("appTheme");
  });

  it("keeps secret paths out of the written bytes and surfaces them to the caller", () => {
    const { json, omittedSecretPaths } = buildConfigBundle(
      { agentSettings: { agents: { a: { globalEnv: { TOKEN: SECRETISH } } } } },
      EXPORTED_AT
    );

    expect(json).not.toContain(SECRETISH);
    expect(omittedSecretPaths).toEqual(["agentSettings.agents.a.globalEnv.TOKEN"]);
  });

  it("round-trips through parseConfigBundle", () => {
    const payload = { keybindingOverrides: { "app.settings": ["Cmd+,"] } };
    const { json } = buildConfigBundle(payload, EXPORTED_AT);

    const parsed = parseConfigBundle(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.sections).toEqual(payload);
    expect(parsed.exportedAt).toBe(EXPORTED_AT);
  });
});

describe("parseConfigBundle", () => {
  function bundle(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION,
      exportedAt: EXPORTED_AT,
      app: "daintree",
      sections: {},
      ...overrides,
    });
  }

  it("rejects a file that isn't JSON", () => {
    const result = parseConfigBundle("not json at all");
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("rejects a bundle from another app", () => {
    const result = parseConfigBundle(bundle({ app: "something-else" }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("something-else");
  });

  it("rejects a file over the size cap without parsing it", () => {
    const oversized = "x".repeat(CONFIG_BUNDLE_MAX_BYTES + 1);
    const result = parseConfigBundle(oversized);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("too large");
  });

  it("accepts an older schema version rather than demanding an exact match", () => {
    const result = parseConfigBundle(
      bundle({
        schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION - 1,
        sections: { worktreeConfig: { pathPattern: "../{n}" } },
      })
    );

    expect(result.ok).toBe(true);
    expect(result.sections.worktreeConfig).toEqual({ pathPattern: "../{n}" });
  });

  it("refuses a bundle written by a newer format than it understands", () => {
    const result = parseConfigBundle(bundle({ schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION + 1 }));

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("newer version");
  });

  it("keeps recognised sections and reports unrecognised ones separately", () => {
    const result = parseConfigBundle(
      bundle({
        sections: {
          worktreeConfig: { pathPattern: "../{n}" },
          somethingFromTheFuture: { a: 1 },
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(Object.keys(result.sections)).toEqual(["worktreeConfig"]);
    expect(result.unknownSections).toEqual(["somethingFromTheFuture"]);
  });

  it("preserves unknown envelope keys instead of failing on them", () => {
    const result = parseConfigBundle(bundle({ writtenBy: "0.99.0" }));
    expect(result.ok).toBe(true);
  });
});

describe("omitSecretValues — arrays and hostile keys", () => {
  it("withholds a whole positional array rather than resequencing it", () => {
    // ["--token", "<secret>"] must not export as ["--token"] — that is a
    // different command, not a redacted one.
    const { value, omitted } = omitSecretValues({ args: ["--token", SECRETISH] }, "agent");

    expect(value).not.toHaveProperty("args");
    expect(omitted).toEqual(["agent.args[1]"]);
  });

  it("keeps an array whose elements are all safe", () => {
    const { value } = omitSecretValues({ args: ["--verbose", "--json"] }, "agent");
    expect(value).toEqual({ args: ["--verbose", "--json"] });
  });

  it("drops only the offending key inside an array of objects", () => {
    const { value } = omitSecretValues(
      { terminals: [{ env: { TOKEN: SECRETISH, MODE: "fast" } }, { env: { MODE: "slow" } }] },
      "recipe"
    );

    expect(value).toEqual({
      terminals: [{ env: { MODE: "fast" } }, { env: { MODE: "slow" } }],
    });
  });

  it("keeps a key named __proto__ as an own property without moving the prototype", () => {
    const { value } = omitSecretValues(
      JSON.parse('{"agents":{"__proto__":{"polluted":true},"real":{"ok":true}}}'),
      ""
    );

    const agents = (value as { agents: Record<string, unknown> }).agents;
    expect(Object.getPrototypeOf(agents)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(agents, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("buildConfigBundle — fully withheld sections", () => {
  it("does not report a section it could not write", () => {
    const { json, sections } = buildConfigBundle(
      { worktreeConfig: { pathPattern: "../{n}" }, keybindingOverrides: [SECRETISH] },
      EXPORTED_AT
    );

    expect(sections).toEqual(["worktreeConfig"]);
    expect(Object.keys(JSON.parse(json).sections)).toEqual(["worktreeConfig"]);
  });
});

describe("parseConfigBundle — byte cap", () => {
  it("measures the cap in bytes, not UTF-16 code units", () => {
    // Each of these is 4 UTF-8 bytes but 2 string units, so a length-based cap
    // would let a file roughly twice the advertised limit through.
    const multibyte = "😀".repeat(Math.ceil(CONFIG_BUNDLE_MAX_BYTES / 4) + 10);
    expect(multibyte.length).toBeLessThan(CONFIG_BUNDLE_MAX_BYTES);

    const result = parseConfigBundle(multibyte);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("too large");
  });
});

describe("credential names in environment maps (#13346)", () => {
  it("withholds an env entry whose name says credential, whatever its value", () => {
    const { sections, omittedSecretPaths } = omitSectionSecrets({
      agentSettings: {
        claude: {
          customFlags: "--verbose",
          globalEnv: { AWS_SECRET_ACCESS_KEY: "plainword", DB_PASSWORD: "hunter2", REGION: "eu" },
          customPresets: [{ id: "p", name: "P", env: { API_KEY: "x", MODE: "fast" } }],
        },
      },
    });
    expect(sections.agentSettings).toEqual({
      claude: {
        customFlags: "--verbose",
        globalEnv: { REGION: "eu" },
        customPresets: [{ id: "p", name: "P", env: { MODE: "fast" } }],
      },
    });
    expect(omittedSecretPaths.sort()).toEqual([
      "agentSettings.claude.customPresets[0].env.API_KEY",
      "agentSettings.claude.globalEnv.AWS_SECRET_ACCESS_KEY",
      "agentSettings.claude.globalEnv.DB_PASSWORD",
    ]);
  });

  it("checks names only inside env maps, so an ordinary field named like one survives", () => {
    const { sections } = omitSectionSecrets({ notificationSettings: { TOKEN: "chime.wav" } });
    expect(sections.notificationSettings).toEqual({ TOKEN: "chime.wav" });
  });

  it("treats the whole global environment section as an env map", () => {
    const { sections, omittedSecretPaths } = omitSectionSecrets({
      globalEnvironment: { GITHUB_TOKEN: "anything", PATH_EXTRA: "/opt/bin" },
    });
    expect(sections.globalEnvironment).toEqual({ PATH_EXTRA: "/opt/bin" });
    expect(omittedSecretPaths).toEqual(["globalEnvironment.GITHUB_TOKEN"]);
  });
});

describe("sections that never travel in a file (#13346)", () => {
  it("leaves permission bypass and the global environment out of an export", () => {
    const { json, sections } = buildConfigBundle(
      {
        worktreeConfig: { pathPattern: "{parent-dir}/wt/{branch-slug}" },
        permissionBypass: { globalSkipPermissions: true },
        globalEnvironment: { LANG: "C" },
      },
      EXPORTED_AT
    );
    expect(sections).toEqual(["worktreeConfig"]);
    expect(Object.keys(JSON.parse(json).sections)).toEqual(["worktreeConfig"]);
  });

  it("refuses them from a hand-edited file, like a section this build doesn't know", () => {
    const result = parseConfigBundle(
      JSON.stringify({
        schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION,
        exportedAt: EXPORTED_AT,
        app: "daintree",
        sections: {
          hibernation: { enabled: true },
          permissionBypass: { globalSkipPermissions: true },
        },
      })
    );
    expect(result.ok).toBe(true);
    expect(Object.keys(result.sections)).toEqual(["hibernation"]);
    expect(result.unknownSections).toEqual(["permissionBypass"]);
  });
});

describe("credentials that no value pattern names (#13346)", () => {
  it("withholds a connection string with a password in it, whatever its scheme", () => {
    const { sections, omittedSecretPaths } = omitSectionSecrets({
      agentSettings: {
        claude: { globalEnv: { DATABASE_URL: "postgresql://alice:hunter2@db/app" } },
      },
    });
    expect(sections.agentSettings).toEqual({ claude: { globalEnv: {} } });
    expect(omittedSecretPaths).toEqual(["agentSettings.claude.globalEnv.DATABASE_URL"]);
  });

  it("withholds an argument list where a credential flag takes the next argument", () => {
    const { sections, omittedSecretPaths } = omitSectionSecrets({
      userAgentRegistry: { mine: { id: "mine", args: ["--verbose", "--token", "plainword"] } },
    });
    expect(sections.userAgentRegistry).toEqual({ mine: { id: "mine" } });
    expect(omittedSecretPaths).toEqual(["userAgentRegistry.mine.args[2]"]);
  });

  it("withholds flag text that carries a credential inline", () => {
    const { sections } = omitSectionSecrets({
      agentSettings: { claude: { customFlags: "--model opus --api-key=plainword" } },
    });
    expect(sections.agentSettings).toEqual({ claude: {} });
  });

  it("keeps ordinary flags and URLs without credentials", () => {
    const payload = {
      agentSettings: {
        claude: {
          customFlags: "--model opus --verbose",
          globalEnv: { API_BASE: "https://example.com/v1" },
        },
      },
    };
    expect(omitSectionSecrets(payload).sections).toEqual(payload);
  });
});
