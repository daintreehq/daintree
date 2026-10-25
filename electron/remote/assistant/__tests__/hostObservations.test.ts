import { describe, expect, it } from "vitest";
import {
  HOST_LIST_CLIS_MAX,
  HostListAgentClisSchema,
  HostListBuildSchema,
  HostListLinkSchema,
} from "../../../../shared/types/hostControl.js";
import type {
  HostConnectionState,
  HostHandshakeInfo,
  HostMetricsSummary,
} from "../../../../shared/types/remoteHosts.js";
import { HOST_LOAD_STALE_MS } from "../hostLoad.js";
import { projectHostAgentClis, projectHostBuild, projectHostLink } from "../hostObservations.js";

const HANDSHAKE: HostHandshakeInfo = {
  version: "0.9.0",
  commit: "abc1234",
  protocolVersion: 12,
  platform: "linux",
  arch: "x64",
};

const NONE = {
  attempt: null,
  restarting: false,
  hostModeOff: false,
  stoppedRetrying: null,
  disconnectedByPerson: false,
  quietSince: null,
  mismatch: null,
};

function summary(overrides: Partial<HostMetricsSummary> = {}): HostMetricsSummary {
  return {
    sampledAt: 1000,
    agentClis: [
      { agentId: "claude", version: "2.1.0" },
      { agentId: "codex", version: null },
    ],
    ...overrides,
  } as HostMetricsSummary;
}

describe("projectHostLink (#14461)", () => {
  const cases: Array<[string, HostConnectionState, boolean, Record<string, unknown>]> = [
    ["local", { status: "local" }, false, {}],
    ["idle disconnected", { status: "disconnected" }, false, {}],
    [
      "disconnected by the person",
      { status: "disconnected" },
      true,
      { disconnectedByPerson: true },
    ],
    ["connecting", { status: "connecting", attempt: 3 }, false, { attempt: 3 }],
    [
      "connecting through an announced restart",
      { status: "connecting", attempt: 1, restarting: true },
      false,
      { attempt: 1, restarting: true },
    ],
    [
      "connected and quiet",
      {
        status: "connected",
        rttMs: 9,
        rttSampledAt: 900,
        handshake: HANDSHAKE,
        quietSince: 950,
      },
      false,
      { quietSince: 950 },
    ],
    [
      "unreachable, still retried",
      { status: "unreachable", lastSeenAt: 100, detail: null },
      false,
      { stoppedRetrying: false },
    ],
    [
      "unreachable, Host mode off",
      {
        status: "unreachable",
        lastSeenAt: 100,
        detail: null,
        hostModeOff: true,
        stoppedRetrying: true,
      },
      false,
      { hostModeOff: true, stoppedRetrying: true },
    ],
    [
      "unreachable, stopped retrying",
      { status: "unreachable", lastSeenAt: null, detail: null, stoppedRetrying: true },
      false,
      { stoppedRetrying: true },
    ],
    [
      "unreachable between dials of a restart",
      { status: "unreachable", lastSeenAt: 100, detail: null, restarting: true },
      false,
      { restarting: true, stoppedRetrying: false },
    ],
    [
      "refused for another protocol",
      {
        status: "version-mismatch",
        mismatch: { kind: "protocol", local: 12, remote: 11 },
        remote: HANDSHAKE,
      },
      false,
      { mismatch: { kind: "protocol", local: "12", remote: "11" } },
    ],
    [
      "driven elsewhere, naming nobody",
      {
        status: "driven-elsewhere",
        driver: {
          leaseId: 3,
          endpointId: "e",
          clientId: "c",
          clientName: "greg-mbp",
          isHostLocal: false,
          acquiredAt: 1,
        },
      },
      false,
      {},
    ],
  ];

  it.each(cases)("keeps what it saw: %s", (_name, state, byPerson, expected) => {
    const link = projectHostLink(state, byPerson);
    expect(link).toEqual({ ...NONE, status: state.status, ...expected });
    expect(HostListLinkSchema.parse(link)).toEqual(link);
  });

  it("keeps a connected link with a different build connected, naming the difference", () => {
    const link = projectHostLink(
      {
        status: "connected",
        rttMs: 4,
        handshake: HANDSHAKE,
        buildMismatch: { kind: "commit", local: "def5678", remote: "abc1234" },
      },
      false
    );
    expect(link).toEqual({
      ...NONE,
      status: "connected",
      mismatch: { kind: "commit", local: "def5678", remote: "abc1234" },
    });
  });

  it("never carries an unreachable link's raw detail", () => {
    const secret =
      "Permission denied (publickey) for greg@10.0.0.4 key /Users/greg/.ssh/id_ed25519";
    const link = projectHostLink(
      { status: "unreachable", lastSeenAt: 5, detail: secret, stoppedRetrying: true },
      false
    );
    expect(JSON.stringify(link)).not.toContain("publickey");
    expect(JSON.stringify(link)).not.toContain(".ssh");
  });

  it("says nothing of a person's disconnect once the link is up again", () => {
    expect(projectHostLink({ status: "connecting", attempt: 1 }, true).disconnectedByPerson).toBe(
      false
    );
  });
});

describe("projectHostBuild (#14461)", () => {
  const CACHED: HostHandshakeInfo = {
    version: "0.8.0",
    commit: "0ld0ld0",
    protocolVersion: 10,
    platform: "darwin",
    arch: "arm64",
  };

  it("prefers the live or refused handshake over an older cached one", () => {
    const current = { ...HANDSHAKE, platform: "darwin" as const, arch: "arm64" as const };
    expect(projectHostBuild({ status: "connected", rttMs: 1, handshake: current }, CACHED)).toEqual(
      { source: "connected", handshake: current }
    );
    expect(
      projectHostBuild(
        {
          status: "version-mismatch",
          mismatch: { kind: "protocol", local: 12, remote: 11 },
          remote: { ...HANDSHAKE, protocolVersion: 11 },
        },
        CACHED
      )
    ).toEqual({ source: "rejected", handshake: { ...HANDSHAKE, protocolVersion: 11 } });
    expect(projectHostBuild({ status: "connecting", attempt: 1 }, CACHED)).toEqual({
      source: "last-seen",
      handshake: CACHED,
    });
  });

  it("clips build strings longer than a handshake may carry", () => {
    const long = { ...HANDSHAKE, version: "v".repeat(100), commit: "c".repeat(100) };
    const build = projectHostBuild({ status: "connected", rttMs: 1, handshake: long }, null);
    expect(build.handshake).toMatchObject({ version: "v".repeat(64), commit: "c".repeat(64) });
    const link = projectHostLink(
      {
        status: "connected",
        rttMs: 1,
        handshake: long,
        buildMismatch: { kind: "version", local: "1".repeat(100), remote: "2".repeat(100) },
      },
      false
    );
    expect(link.mismatch).toEqual({
      kind: "version",
      local: "1".repeat(64),
      remote: "2".repeat(64),
    });
  });

  it("names the build it is connected to", () => {
    const build = projectHostBuild({ status: "connected", rttMs: 1, handshake: HANDSHAKE }, null);
    expect(build).toEqual({ source: "connected", handshake: HANDSHAKE });
    expect(HostListBuildSchema.parse(build)).toEqual(build);
  });

  it("names the build it refused", () => {
    expect(
      projectHostBuild(
        {
          status: "version-mismatch",
          mismatch: { kind: "version", local: "1.0.0", remote: "0.9.0" },
          remote: HANDSHAKE,
        },
        null
      )
    ).toEqual({ source: "rejected", handshake: HANDSHAKE });
  });

  it("falls back to the last handshake seen, said to be from then", () => {
    expect(projectHostBuild({ status: "disconnected" }, HANDSHAKE)).toEqual({
      source: "last-seen",
      handshake: HANDSHAKE,
    });
  });

  it("is unknown with no handshake ever seen", () => {
    expect(
      projectHostBuild({ status: "unreachable", lastSeenAt: null, detail: null }, null)
    ).toEqual({ source: "unknown", handshake: null });
  });

  it("copies only the handshake's own fields", () => {
    const build = projectHostBuild(
      { status: "connected", rttMs: 1, handshake: { ...HANDSHAKE, extra: "x" } as never },
      null
    );
    expect(build.handshake).toEqual(HANDSHAKE);
  });
});

describe("projectHostAgentClis (#14461)", () => {
  it("lists a fresh sample from a live link as observed", () => {
    const clis = projectHostAgentClis(summary(), true, 1000 + HOST_LOAD_STALE_MS);
    expect(clis).toEqual({
      coverage: "observed",
      sampledAt: 1000,
      installed: [
        { agentId: "claude", version: "2.1.0" },
        { agentId: "codex", version: null },
      ],
      omitted: 0,
    });
    expect(HostListAgentClisSchema.parse(clis)).toEqual(clis);
  });

  it("keeps an old sample's CLIs as stale", () => {
    expect(projectHostAgentClis(summary(), true, 1001 + HOST_LOAD_STALE_MS)).toEqual({
      coverage: "stale",
      sampledAt: 1000,
      installed: [
        { agentId: "claude", version: "2.1.0" },
        { agentId: "codex", version: null },
      ],
      omitted: 0,
    });
  });

  it("keeps a sample from a host that is no longer connected as stale, however recent", () => {
    expect(projectHostAgentClis(summary(), false, 1000).coverage).toBe("stale");
  });

  it("treats a sample far ahead of this clock as stale", () => {
    expect(projectHostAgentClis(summary({ sampledAt: 1e12 }), true, 1000).coverage).toBe("stale");
  });

  it("is unknown with no summary", () => {
    expect(projectHostAgentClis(null, true, 1000)).toEqual({
      coverage: "unknown",
      sampledAt: null,
      installed: [],
      omitted: 0,
    });
  });

  it("reads an empty list as unknown, not as nothing installed", () => {
    expect(projectHostAgentClis(summary({ agentClis: [] }), true, 1000)).toEqual({
      coverage: "unknown",
      sampledAt: 1000,
      installed: [],
      omitted: 0,
    });
  });

  it("copies only an id and a version, each clipped", () => {
    const clis = projectHostAgentClis(
      summary({
        agentClis: [
          { agentId: "a".repeat(300), version: "1.0", path: "/opt/bin/claude", token: "s3cret" },
        ] as never,
      }),
      true,
      1000
    );
    expect(clis.installed).toEqual([{ agentId: "a".repeat(64), version: "1.0" }]);
  });

  it("caps the list and counts what it left out", () => {
    const many = Array.from({ length: HOST_LIST_CLIS_MAX + 5 }, (_, i) => ({
      agentId: `agent-${i}`,
      version: "1".repeat(200),
    }));
    const clis = projectHostAgentClis(summary({ agentClis: many }), true, 1000);
    expect(clis.installed).toHaveLength(HOST_LIST_CLIS_MAX);
    expect(clis.omitted).toBe(5);
    expect(clis.installed[0]!.version).toHaveLength(64);
    expect(HostListAgentClisSchema.parse(clis)).toEqual(clis);
  });
});
