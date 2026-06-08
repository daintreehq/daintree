import { describe, expect, it } from "vitest";
import { fc, test } from "@fast-check/vitest";
import {
  __internal,
  PROJECT_SETTINGS_SCHEMA_VERSION,
  ProjectSettingsSaveSchema,
  decode,
  encodeEnvelope,
} from "../projectSettingsCodec.js";

describe("decode", () => {
  it("returns empty defaults for non-object input", () => {
    expect(decode(null)).toEqual({ ok: true, settings: { runCommands: [] } });
    expect(decode(undefined)).toEqual({ ok: true, settings: { runCommands: [] } });
    expect(decode(42)).toEqual({ ok: true, settings: { runCommands: [] } });
    expect(decode("hi")).toEqual({ ok: true, settings: { runCommands: [] } });
    expect(decode([1, 2, 3])).toEqual({ ok: true, settings: { runCommands: [] } });
  });

  it("flags future-version envelopes for quarantine", () => {
    const result = decode({ _schemaVersion: PROJECT_SETTINGS_SCHEMA_VERSION + 1 });
    expect(result).toEqual({
      ok: false,
      reason: "future-version",
      onDiskVersion: PROJECT_SETTINGS_SCHEMA_VERSION + 1,
    });
  });

  it("accepts current-version envelopes", () => {
    const result = decode({ _schemaVersion: PROJECT_SETTINGS_SCHEMA_VERSION, runCommands: [] });
    expect(result.ok).toBe(true);
  });

  it("treats absent _schemaVersion as legacy v0 and migrates", () => {
    const result = decode({
      runCommands: [],
      resourceEnvironment: { provision: ["echo hi"] },
      exposeDaintreeMcpToAgents: true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.resourceEnvironments).toEqual({
      default: { provision: ["echo hi"] },
    });
    expect(result.settings.activeResourceEnvironment).toBe("default");
    expect(result.settings.daintreeMcpTier).toBe("workbench");
  });

  it("preserves canonical resourceEnvironments when both shapes are present", () => {
    const result = decode({
      runCommands: [],
      resourceEnvironment: { provision: ["should-be-ignored"] },
      resourceEnvironments: { staging: { provision: ["echo staging"] } },
      activeResourceEnvironment: "staging",
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.resourceEnvironments).toEqual({
      staging: { provision: ["echo staging"] },
    });
    expect(result.settings.activeResourceEnvironment).toBe("staging");
  });

  it("preserves canonical daintreeMcpTier when both shapes are present", () => {
    const result = decode({
      runCommands: [],
      daintreeMcpTier: "system",
      exposeDaintreeMcpToAgents: true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.daintreeMcpTier).toBe("system");
    expect(result.settings.exposeDaintreeMcpToAgents).toBe(true);
  });

  it("rejects unknown daintreeMcpTier values", () => {
    const result = decode({ runCommands: [], daintreeMcpTier: "godmode" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.daintreeMcpTier).toBeUndefined();
  });

  it("preserves null forgeProviderOverride as explicit unset", () => {
    const result = decode({ runCommands: [], forgeProviderOverride: null });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.forgeProviderOverride).toBeNull();
  });

  it("drops non-string forgeProviderOverride values", () => {
    const result = decode({ runCommands: [], forgeProviderOverride: 42 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.forgeProviderOverride).toBeUndefined();
  });

  it("migrates legacy githubRemote to forgeRemote", () => {
    const result = decode({ runCommands: [], githubRemote: "upstream" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.forgeRemote).toBe("upstream");
    expect(result.settings.githubRemote).toBeUndefined();
  });

  it("prefers forgeRemote over legacy githubRemote when both are present", () => {
    const result = decode({ runCommands: [], forgeRemote: "fork", githubRemote: "upstream" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.forgeRemote).toBe("fork");
    expect(result.settings.githubRemote).toBeUndefined();
  });

  it("falls through to legacy githubRemote when forgeRemote is blank", () => {
    const result = decode({ runCommands: [], forgeRemote: "  ", githubRemote: "upstream" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.forgeRemote).toBe("upstream");
  });

  it("drops a blank forgeRemote with no legacy fallback", () => {
    const result = decode({ runCommands: [], forgeRemote: "" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.forgeRemote).toBeUndefined();
  });

  it("filters invalid runCommands entries", () => {
    const result = decode({
      runCommands: [
        { id: "ok", name: "dev", command: "npm run dev" },
        { id: 123, command: "x" },
        null,
        { id: "missing-command" },
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.runCommands).toHaveLength(1);
    expect(result.settings.runCommands[0]?.id).toBe("ok");
  });

  it("regression #10001: string alwaysExclude is dropped through public decode()", () => {
    const result = decode({ runCommands: [], copyTreeSettings: { alwaysExclude: "dist" } });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.copyTreeSettings).toBeUndefined();
  });

  it("regression #10001: { length: 1 } alwaysExclude is dropped through public decode()", () => {
    const result = decode({
      runCommands: [],
      copyTreeSettings: { alwaysExclude: { length: 1 } },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.copyTreeSettings).toBeUndefined();
  });

  it("regression #10001: string maxContextSize is dropped through public decode()", () => {
    const result = decode({
      runCommands: [],
      copyTreeSettings: { maxContextSize: "100000" },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.copyTreeSettings).toBeUndefined();
  });

  it("regression #10001: string alwaysInclude is dropped through public decode()", () => {
    const result = decode({
      runCommands: [],
      copyTreeSettings: { alwaysInclude: "README.md" },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.copyTreeSettings).toBeUndefined();
  });

  it("regression #10001: well-formed copyTreeSettings round-trips through public decode()", () => {
    const result = decode({
      runCommands: [],
      copyTreeSettings: {
        maxContextSize: 1_000_000,
        strategy: "modified",
        alwaysInclude: ["README.md"],
        alwaysExclude: ["dist", "node_modules"],
      },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.copyTreeSettings).toEqual({
      maxContextSize: 1_000_000,
      strategy: "modified",
      alwaysInclude: ["README.md"],
      alwaysExclude: ["dist", "node_modules"],
    });
  });

  it("drops resourceEnvironments whose every command array is non-string", () => {
    const result = decode({
      runCommands: [],
      resourceEnvironments: { s: { provision: [1, null, false] } },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.resourceEnvironments).toBeUndefined();
  });

  it("preserves empty resourceEnvironments as named modes", () => {
    const result = decode({
      runCommands: [],
      resourceEnvironments: { "e2e-docker": {} },
      activeResourceEnvironment: "e2e-docker",
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.resourceEnvironments).toEqual({ "e2e-docker": {} });
    expect(result.settings.activeResourceEnvironment).toBe("e2e-docker");
  });

  it("preserves valid resourceEnvironments siblings when one entry is invalid", () => {
    const result = decode({
      runCommands: [],
      resourceEnvironments: {
        good: { provision: ["echo"] },
        bad: { provision: "not-an-array" },
      },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.resourceEnvironments).toEqual({ good: { provision: ["echo"] } });
  });

  it("guards against __proto__ pollution in resourceEnvironments keys", () => {
    // JSON.parse on a string with "__proto__" sets the prototype rather than
    // an own property, so this construction is the realistic hostile-input
    // shape. The decoder must not let a __proto__ entry slip through and
    // pollute the result's prototype chain.
    const hostile = JSON.parse('{"__proto__":{"provision":["x"]},"good":{"provision":["ok"]}}');
    const result = decode({ runCommands: [], resourceEnvironments: hostile });
    if (!result.ok) throw new Error("expected ok");
    const envs = result.settings.resourceEnvironments as Record<string, unknown>;
    expect(envs).toBeDefined();
    expect("provision" in envs).toBe(false);
    expect(envs.good).toEqual({ provision: ["ok"] });
  });
});

describe("encodeEnvelope", () => {
  it("prepends the schema version", () => {
    const enc = encodeEnvelope({ runCommands: [] });
    expect(enc._schemaVersion).toBe(PROJECT_SETTINGS_SCHEMA_VERSION);
  });

  it("strips transient runtime-only fields", () => {
    const enc = encodeEnvelope({
      runCommands: [],
      insecureEnvironmentVariables: ["SECRET"],
      unresolvedSecureEnvironmentVariables: ["UNRESOLVED"],
    });
    expect(enc.insecureEnvironmentVariables).toBeUndefined();
    expect(enc.unresolvedSecureEnvironmentVariables).toBeUndefined();
  });

  it("strips legacy migration fields so they don't survive forward", () => {
    const enc = encodeEnvelope({
      runCommands: [],
      resourceEnvironment: { provision: ["legacy"] },
      exposeDaintreeMcpToAgents: true,
      githubRemote: "upstream",
      forgeRemote: "upstream",
    });
    expect(enc.resourceEnvironment).toBeUndefined();
    expect(enc.exposeDaintreeMcpToAgents).toBeUndefined();
    expect(enc.githubRemote).toBeUndefined();
    expect(enc.forgeRemote).toBe("upstream");
  });

  it("strips agentInstructions so the runtime helper never reaches disk", () => {
    const enc = encodeEnvelope({
      runCommands: [],
      // Cast through unknown — `agentInstructions` is a runtime-only field
      // not in the public ProjectSettings interface but documented as
      // strippable on save.
      agentInstructions: "do the thing",
    } as unknown as Parameters<typeof encodeEnvelope>[0]);
    expect(enc.agentInstructions).toBeUndefined();
  });

  it("forces _schemaVersion to the codec's value even if the caller injected one", () => {
    const enc = encodeEnvelope({
      runCommands: [],
      // Caller-supplied _schemaVersion must NEVER survive — the encoder is
      // the single authority for the on-disk version.
      _schemaVersion: 999,
    } as unknown as Parameters<typeof encodeEnvelope>[0]);
    expect(enc._schemaVersion).toBe(PROJECT_SETTINGS_SCHEMA_VERSION);
  });

  it("preserves canonical fields", () => {
    const enc = encodeEnvelope({
      runCommands: [{ id: "r1", name: "n", command: "c" }],
      resourceEnvironments: { default: { provision: ["echo"] } },
      daintreeMcpTier: "workbench",
    });
    expect(enc.runCommands).toEqual([{ id: "r1", name: "n", command: "c" }]);
    expect(enc.resourceEnvironments).toEqual({ default: { provision: ["echo"] } });
    expect(enc.daintreeMcpTier).toBe("workbench");
  });
});

describe("decode is total", () => {
  test.prop([fc.anything()])("never throws on arbitrary input", (raw) => {
    expect(() => decode(raw)).not.toThrow();
  });
});

describe("round-trip", () => {
  const canonicalSettingsArb = fc.record(
    {
      runCommands: fc.array(
        fc.record(
          {
            id: fc.string({ minLength: 1 }),
            name: fc.string({ minLength: 1 }),
            command: fc.string({ minLength: 1 }),
          },
          { requiredKeys: ["id", "name", "command"] }
        ),
        { maxLength: 3 }
      ),
      turbopackEnabled: fc.boolean(),
      daintreeMcpTier: fc.constantFrom("off", "workbench", "action", "system"),
    },
    { requiredKeys: ["runCommands"] }
  );

  test.prop([canonicalSettingsArb])("decode(encode(decode(x))) deep-equals decode(x)", (raw) => {
    const first = decode(raw);
    if (!first.ok) return;
    const envelope = encodeEnvelope(first.settings);
    const second = decode(envelope);
    if (!second.ok) throw new Error("encoded envelope failed to decode");
    expect(second.settings).toEqual(first.settings);
  });
});

describe("migration is idempotent", () => {
  const legacyArb = fc.record(
    {
      runCommands: fc.constant([]),
      resourceEnvironment: fc.option(
        fc.record(
          { provision: fc.array(fc.string(), { maxLength: 2 }) },
          { requiredKeys: ["provision"] }
        )
      ),
      exposeDaintreeMcpToAgents: fc.option(fc.boolean()),
    },
    { requiredKeys: ["runCommands"] }
  );

  test.prop([legacyArb])("migrate(migrate(x)) deep-equals migrate(x)", (raw) => {
    const once = __internal.migrateLegacyFields(raw as Record<string, unknown>);
    const twice = __internal.migrateLegacyFields(once);
    expect(twice).toEqual(once);
  });
});

describe("ProjectSettingsSaveSchema", () => {
  it("permits both daintreeMcpTier and exposeDaintreeMcpToAgents (strip happens at action layer)", () => {
    const result = ProjectSettingsSaveSchema.safeParse({
      runCommands: [],
      daintreeMcpTier: "workbench",
      exposeDaintreeMcpToAgents: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-object payloads", () => {
    expect(ProjectSettingsSaveSchema.safeParse(null).success).toBe(false);
    expect(ProjectSettingsSaveSchema.safeParse("hi").success).toBe(false);
    expect(ProjectSettingsSaveSchema.safeParse(42).success).toBe(false);
  });

  it("rejects invalid daintreeMcpTier values", () => {
    const result = ProjectSettingsSaveSchema.safeParse({
      runCommands: [],
      daintreeMcpTier: "godmode",
    });
    expect(result.success).toBe(false);
  });

  it("accepts forgeProviderOverride null", () => {
    expect(
      ProjectSettingsSaveSchema.safeParse({ runCommands: [], forgeProviderOverride: null }).success
    ).toBe(true);
  });

  it("preserves unknown forward-compat fields via passthrough", () => {
    const result = ProjectSettingsSaveSchema.safeParse({
      runCommands: [],
      futureField: { foo: "bar" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).futureField).toEqual({ foo: "bar" });
    }
  });

  it("rejects caller-supplied _schemaVersion in IPC payloads", () => {
    const result = ProjectSettingsSaveSchema.safeParse({
      runCommands: [],
      _schemaVersion: 999,
    });
    expect(result.success).toBe(false);
  });
});

describe("malformed _schemaVersion values", () => {
  it.each([
    ["string version", "999"],
    ["float version", 1.5],
    ["negative version", -1],
    ["NaN version", Number.NaN],
    ["Infinity version", Number.POSITIVE_INFINITY],
  ])("treats %s as legacy v0 rather than future-version", (_, version) => {
    const result = decode({ _schemaVersion: version, runCommands: [] });
    expect(result.ok).toBe(true);
  });
});

describe("decodeTerminalSettings (internal)", () => {
  it("returns undefined for null/undefined/non-object", () => {
    expect(__internal.decodeTerminalSettings(null)).toBeUndefined();
    expect(__internal.decodeTerminalSettings(undefined)).toBeUndefined();
    expect(__internal.decodeTerminalSettings("string")).toBeUndefined();
  });

  it("parses valid terminal settings", () => {
    const result = __internal.decodeTerminalSettings({
      shell: "/bin/zsh",
      shellArgs: ["-l"],
      defaultWorkingDirectory: "/home/user",
      scrollbackLines: 5000,
    });
    expect(result).toEqual({
      shell: "/bin/zsh",
      shellArgs: ["-l"],
      defaultWorkingDirectory: "/home/user",
      scrollbackLines: 5000,
    });
  });

  it("drops non-absolute shell paths", () => {
    expect(__internal.decodeTerminalSettings({ shell: "zsh" })).toBeUndefined();
  });

  it("filters non-string shellArgs", () => {
    const result = __internal.decodeTerminalSettings({
      shellArgs: ["-l", 42 as unknown, true as unknown],
    });
    expect(result?.shellArgs).toEqual(["-l"]);
  });
});

describe("decodeNotificationOverrides (internal)", () => {
  it("returns undefined for empty input", () => {
    expect(__internal.decodeNotificationOverrides(null)).toBeUndefined();
    expect(__internal.decodeNotificationOverrides({})).toBeUndefined();
  });

  it("maps legacy soundFile to completedSoundFile", () => {
    expect(__internal.decodeNotificationOverrides({ soundFile: "chime.wav" })).toEqual({
      completedSoundFile: "chime.wav",
    });
  });

  it("rejects unknown sound files", () => {
    expect(
      __internal.decodeNotificationOverrides({ completedSoundFile: "malicious.wav" })
    ).toBeUndefined();
  });

  it("clamps waitingEscalationDelayMs to [30s, 1h]", () => {
    expect(
      __internal.decodeNotificationOverrides({ waitingEscalationDelayMs: 1000 })
        ?.waitingEscalationDelayMs
    ).toBe(30_000);
    expect(
      __internal.decodeNotificationOverrides({ waitingEscalationDelayMs: 99_999_999 })
        ?.waitingEscalationDelayMs
    ).toBe(3_600_000);
  });
});

describe("decodeFleetSavedScopes (internal)", () => {
  it("parses snapshot scopes", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "Sprint",
        terminalIds: ["a", "b"],
        createdAt: 1700000000000,
      },
    ]);
    expect(result?.[0]).toMatchObject({ kind: "snapshot", id: "s1" });
  });

  it("drops invalid entries and returns undefined when all are dropped", () => {
    expect(__internal.decodeFleetSavedScopes([{ garbage: true }])).toBeUndefined();
  });

  it("preserves valid recency fields on a snapshot scope", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "Recency",
        terminalIds: ["a"],
        createdAt: 1700000000000,
        lastUsedAt: 1710000000000,
        usageHistory: [1709000000000, 1710000000000],
      },
    ]);
    const scope = result?.[0];
    expect(scope?.kind).toBe("snapshot");
    expect((scope as { lastUsedAt?: number } | undefined)?.lastUsedAt).toBe(1710000000000);
    expect((scope as { usageHistory?: number[] } | undefined)?.usageHistory).toEqual([
      1709000000000, 1710000000000,
    ]);
  });

  it("preserves valid recency fields on a predicate scope", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "predicate",
        id: "p1",
        name: "Recency",
        scope: "all",
        stateFilter: "working",
        createdAt: 1700000000000,
        lastUsedAt: 1710000000000,
        usageHistory: [1709000000000, 1710000000000],
      },
    ]);
    const scope = result?.[0];
    expect(scope?.kind).toBe("predicate");
    expect((scope as { lastUsedAt?: number } | undefined)?.lastUsedAt).toBe(1710000000000);
    expect((scope as { usageHistory?: number[] } | undefined)?.usageHistory).toEqual([
      1709000000000, 1710000000000,
    ]);
  });

  it("decodes a scope without recency fields (backwards compat)", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "No Recency",
        terminalIds: ["a"],
        createdAt: 1700000000000,
      },
    ]);
    const scope = result?.[0];
    expect(scope).toBeDefined();
    expect((scope as { lastUsedAt?: unknown } | undefined)?.lastUsedAt).toBeUndefined();
    expect((scope as { usageHistory?: unknown } | undefined)?.usageHistory).toBeUndefined();
  });

  it("silently drops malformed lastUsedAt (non-number)", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "Bad",
        terminalIds: ["a"],
        createdAt: 1700000000000,
        lastUsedAt: "not-a-number",
      },
    ]);
    expect(result?.[0]).toBeDefined();
    expect((result?.[0] as { lastUsedAt?: unknown } | undefined)?.lastUsedAt).toBeUndefined();
  });

  it("silently drops malformed lastUsedAt (NaN)", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "Bad",
        terminalIds: ["a"],
        createdAt: 1700000000000,
        lastUsedAt: NaN,
      },
    ]);
    expect(result?.[0]).toBeDefined();
    expect((result?.[0] as { lastUsedAt?: unknown } | undefined)?.lastUsedAt).toBeUndefined();
  });

  it("filters non-finite entries from usageHistory", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "Bad",
        terminalIds: ["a"],
        createdAt: 1700000000000,
        usageHistory: [1709000000000, "bad", NaN, Infinity, 1710000000000],
      },
    ]);
    const history = (result?.[0] as { usageHistory?: number[] } | undefined)?.usageHistory;
    expect(history).toEqual([1709000000000, 1710000000000]);
  });

  it("drops usageHistory when it is not an array", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "Bad",
        terminalIds: ["a"],
        createdAt: 1700000000000,
        usageHistory: "not-an-array",
      },
    ]);
    expect((result?.[0] as { usageHistory?: unknown } | undefined)?.usageHistory).toBeUndefined();
  });

  it("drops usageHistory when filtered result is empty", () => {
    const result = __internal.decodeFleetSavedScopes([
      {
        kind: "snapshot",
        id: "s1",
        name: "Bad",
        terminalIds: ["a"],
        createdAt: 1700000000000,
        usageHistory: ["all", "bad", "entries"],
      },
    ]);
    expect((result?.[0] as { usageHistory?: unknown } | undefined)?.usageHistory).toBeUndefined();
  });
});

describe("decodeCopyTreeSettings (internal)", () => {
  it("returns undefined for null/undefined/non-object/array", () => {
    expect(__internal.decodeCopyTreeSettings(null)).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings(undefined)).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings("s")).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings(42)).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings(true)).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings([1, 2])).toBeUndefined();
  });

  it("returns undefined for an empty object", () => {
    expect(__internal.decodeCopyTreeSettings({})).toBeUndefined();
  });

  it("parses a valid full object", () => {
    expect(
      __internal.decodeCopyTreeSettings({
        maxContextSize: 1_000_000,
        maxFileSize: 50_000,
        charLimit: 8000,
        strategy: "modified",
        alwaysInclude: ["README.md"],
        alwaysExclude: ["dist", "node_modules"],
      })
    ).toEqual({
      maxContextSize: 1_000_000,
      maxFileSize: 50_000,
      charLimit: 8000,
      strategy: "modified",
      alwaysInclude: ["README.md"],
      alwaysExclude: ["dist", "node_modules"],
    });
  });

  it("parses strategy 'all' and 'modified' only", () => {
    expect(__internal.decodeCopyTreeSettings({ strategy: "all" })).toEqual({ strategy: "all" });
    expect(__internal.decodeCopyTreeSettings({ strategy: "modified" })).toEqual({
      strategy: "modified",
    });
  });

  it("drops invalid strategy values", () => {
    expect(__internal.decodeCopyTreeSettings({ strategy: "changed" })).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings({ strategy: "" })).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings({ strategy: null })).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings({ strategy: 1 })).toBeUndefined();
  });

  it("drops non-finite numerics (Infinity, -Infinity, NaN)", () => {
    expect(
      __internal.decodeCopyTreeSettings({
        maxContextSize: Number.POSITIVE_INFINITY,
        maxFileSize: Number.NEGATIVE_INFINITY,
        charLimit: Number.NaN,
      })
    ).toBeUndefined();
  });

  it("drops numeric strings (no coercion)", () => {
    expect(
      __internal.decodeCopyTreeSettings({
        maxContextSize: "100000",
        maxFileSize: "50000",
        charLimit: "8000",
      })
    ).toBeUndefined();
  });

  it("filters bad elements inside alwaysInclude/alwaysExclude", () => {
    expect(
      __internal.decodeCopyTreeSettings({
        alwaysInclude: ["README.md", 1, null, "src/**", false],
        alwaysExclude: ["dist", {}, ["nested"], "node_modules"],
      })
    ).toEqual({
      alwaysInclude: ["README.md", "src/**"],
      alwaysExclude: ["dist", "node_modules"],
    });
  });

  it("drops empty arrays and arrays with no valid strings", () => {
    expect(__internal.decodeCopyTreeSettings({ alwaysInclude: [] })).toBeUndefined();
    expect(__internal.decodeCopyTreeSettings({ alwaysExclude: [1, null, false] })).toBeUndefined();
  });

  it("regression #10001: string alwaysExclude is dropped", () => {
    // Pre-fix: "dist".length > 0, spread turns into single chars.
    expect(__internal.decodeCopyTreeSettings({ alwaysExclude: "dist" })).toBeUndefined();
  });

  it("regression #10001: { length: 1 } alwaysExclude is dropped", () => {
    // Pre-fix: passes the .length > 0 guard, then throws on spread.
    expect(__internal.decodeCopyTreeSettings({ alwaysExclude: { length: 1 } })).toBeUndefined();
  });

  it("regression #10001: string maxContextSize is dropped", () => {
    expect(__internal.decodeCopyTreeSettings({ maxContextSize: "100000" })).toBeUndefined();
  });

  it("regression #10001: string alwaysInclude is dropped", () => {
    expect(__internal.decodeCopyTreeSettings({ alwaysInclude: "README.md" })).toBeUndefined();
  });

  it("keeps valid siblings when one field is invalid", () => {
    expect(
      __internal.decodeCopyTreeSettings({
        maxContextSize: 1_000_000,
        alwaysInclude: "README.md",
        alwaysExclude: ["dist"],
      })
    ).toEqual({ maxContextSize: 1_000_000, alwaysExclude: ["dist"] });
  });

  test.prop([fc.anything()])("never throws on arbitrary input", (raw) => {
    expect(() => __internal.decodeCopyTreeSettings(raw)).not.toThrow();
  });
});

describe("decodeResourceEnvironments (internal)", () => {
  it("returns undefined for null/undefined/non-object/array", () => {
    expect(__internal.decodeResourceEnvironments(null)).toBeUndefined();
    expect(__internal.decodeResourceEnvironments(undefined)).toBeUndefined();
    expect(__internal.decodeResourceEnvironments("s")).toBeUndefined();
    expect(__internal.decodeResourceEnvironments(42)).toBeUndefined();
    expect(__internal.decodeResourceEnvironments([{ provision: ["a"] }])).toBeUndefined();
  });

  it("returns undefined for an empty object", () => {
    expect(__internal.decodeResourceEnvironments({})).toBeUndefined();
  });

  it("parses a full valid environment", () => {
    expect(
      __internal.decodeResourceEnvironments({
        staging: {
          provision: ["npm ci"],
          teardown: ["rm -rf build"],
          resume: ["docker start x"],
          pause: ["docker stop x"],
          status: "echo ok",
          connect: "ssh staging",
          icon: "database",
        },
      })
    ).toEqual({
      staging: {
        provision: ["npm ci"],
        teardown: ["rm -rf build"],
        resume: ["docker start x"],
        pause: ["docker stop x"],
        status: "echo ok",
        connect: "ssh staging",
        icon: "database",
      },
    });
  });

  it("filters bad elements inside command arrays", () => {
    expect(
      __internal.decodeResourceEnvironments({
        s: { provision: ["a", 1, null, "b", { cmd: "x" }] },
      })
    ).toEqual({ s: { provision: ["a", "b"] } });
  });

  it("drops command fields that are not arrays", () => {
    expect(
      __internal.decodeResourceEnvironments({
        s: {
          provision: "npm install",
          teardown: { length: 1 },
          resume: null,
          pause: 42,
        },
      })
    ).toBeUndefined();
  });

  it("drops empty command arrays and arrays with no valid strings", () => {
    expect(__internal.decodeResourceEnvironments({ s: { provision: [] } })).toBeUndefined();
    expect(
      __internal.decodeResourceEnvironments({ s: { provision: [1, null, false] } })
    ).toBeUndefined();
  });

  it("preserves valid scalar string fields", () => {
    expect(
      __internal.decodeResourceEnvironments({
        s: { status: "echo ok", connect: "ssh x", icon: "database" },
      })
    ).toEqual({ s: { status: "echo ok", connect: "ssh x", icon: "database" } });
  });

  it("drops invalid scalar fields (arrays, numbers, null)", () => {
    expect(
      __internal.decodeResourceEnvironments({
        s: { status: ["echo ok"], connect: 123, icon: null },
      })
    ).toBeUndefined();
  });

  it("keeps valid sibling environments when one entry is invalid", () => {
    expect(
      __internal.decodeResourceEnvironments({
        good: { provision: ["echo"] },
        bad: { provision: "not-an-array" },
      })
    ).toEqual({ good: { provision: ["echo"] } });
  });

  it("returns undefined when every environment entry is invalid", () => {
    expect(
      __internal.decodeResourceEnvironments({
        a: "not-an-object",
        b: ["also", "wrong"],
        c: null,
      })
    ).toBeUndefined();
  });

  test.prop([fc.anything()])("never throws on arbitrary input", (raw) => {
    expect(() => __internal.decodeResourceEnvironments(raw)).not.toThrow();
  });
});
