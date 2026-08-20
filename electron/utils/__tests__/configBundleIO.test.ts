import { describe, expect, it } from "vitest";
import { buildConfigBundle, omitSecretValues, parseConfigBundle } from "../configBundleIO.js";
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

  it("omits rather than redacts, so no placeholder can be imported over a real value", () => {
    const { value } = omitSecretValues({ apiKey: SECRETISH }, "");
    expect(Object.keys(value as object)).not.toContain("apiKey");
    expect(JSON.stringify(value)).not.toContain("REDACTED");
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
