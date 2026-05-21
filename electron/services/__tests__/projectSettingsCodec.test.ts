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
