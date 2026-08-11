import { describe, expect, it } from "vitest";
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteAgentRunSchema,
  RemoteEnvelopeSchema,
  RemoteLaunchAgentRequestSchema,
  RemoteProjectSummarySchema,
  RemoteSubmitPromptRequestSchema,
  RemoteWorktreeSummarySchema,
  negotiateRemoteProtocol,
  parseRemoteFrame,
} from "../index.js";

const project = {
  id: "project-01",
  name: "Daintree",
  status: "active" as const,
  attention: { waiting: 1, working: 2, completed: 3 },
  order: 0,
};

const worktree = {
  id: "worktree-01",
  name: "portal",
  branch: "feature/portal",
  isMain: false,
  isCurrent: true,
  availability: "available" as const,
};

const agent = {
  panelId: "panel-01",
  launchGeneration: 2,
  projectId: project.id,
  worktreeId: worktree.id,
  agentId: "codex",
  displayName: "Codex",
  title: "Portal protocol",
  state: "working" as const,
  connectionState: "live" as const,
  continuityState: "live" as const,
  resumeState: "resumable-by-cli" as const,
  stateSince: 1_700_000_000_000,
  spawnedAt: 1_700_000_000_000,
  spawnedRemotely: true,
  resumable: true,
};

const request = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  sessionId: "session-01",
  kind: "request" as const,
  type: "projects.list" as const,
  requestId: "request-01",
  payload: {},
};

describe("remote protocol envelopes", () => {
  it("round-trips strict request, response, event, and acknowledgement envelopes", () => {
    const envelopes = [
      request,
      {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: "session-01",
        kind: "response",
        type: "project.snapshot",
        requestId: "request-02",
        payload: {
          project,
          worktrees: [worktree],
          agents: [agent],
          revision: 4,
          projectionState: "available",
          degraded: false,
          lastSuccessfulAt: 1_700_000_000_000,
        },
      },
      {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: "session-01",
        kind: "event",
        type: "console.output",
        streamId: "stream-01",
        seq: 8,
        payload: {
          streamId: "stream-01",
          panelId: agent.panelId,
          launchGeneration: agent.launchGeneration,
          seq: 8,
          data: "aGVsbG8=",
          encoding: "base64",
          bytes: 5,
        },
      },
      {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: "session-01",
        kind: "ack",
        type: "stream.ack",
        streamId: "stream-01",
        ack: 8,
      },
    ];

    for (const envelope of envelopes) {
      const parsed = RemoteEnvelopeSchema.parse(envelope);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(envelope);
    }
  });

  it("rejects unknown message types and unknown fields at envelope and payload boundaries", () => {
    expect(RemoteEnvelopeSchema.safeParse({ ...request, type: "projects.delete" }).success).toBe(
      false
    );
    expect(RemoteEnvelopeSchema.safeParse({ ...request, rendererState: {} }).success).toBe(false);
    expect(
      RemoteEnvelopeSchema.safeParse({ ...request, payload: { includeFilesystemPaths: true } })
        .success
    ).toBe(false);
  });

  it("classifies invalid JSON, oversized frames, and schema-invalid JSON predictably", () => {
    expect(parseRemoteFrame("{")).toMatchObject({
      ok: false,
      error: { code: "MALFORMED_FRAME", retryable: false },
    });
    expect(parseRemoteFrame(JSON.stringify(request), 1)).toMatchObject({
      ok: false,
      error: { code: "FRAME_TOO_LARGE", retryable: false },
    });
    expect(parseRemoteFrame(JSON.stringify({ ...request, protocolVersion: 999 }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", retryable: false },
    });
  });
});

describe("remote protocol negotiation", () => {
  it("selects the host version only when it falls inside the client range", () => {
    expect(
      negotiateRemoteProtocol({
        min: REMOTE_PROTOCOL_VERSION,
        max: REMOTE_PROTOCOL_VERSION + 1,
      })
    ).toEqual({ ok: true, protocolVersion: REMOTE_PROTOCOL_VERSION });
  });

  it("returns a typed incompatibility without producing session or authentication state", () => {
    const result = negotiateRemoteProtocol({
      min: REMOTE_PROTOCOL_VERSION + 1,
      max: REMOTE_PROTOCOL_VERSION + 2,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_VERSION", retryable: false },
    });
    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("capabilities");
  });

  it("rejects inverted client ranges as incompatible", () => {
    expect(
      negotiateRemoteProtocol({
        min: REMOTE_PROTOCOL_VERSION + 1,
        max: REMOTE_PROTOCOL_VERSION,
      })
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } });
  });
});

describe("remote DTO redaction boundary", () => {
  it.each([
    [RemoteProjectSummarySchema, project],
    [RemoteWorktreeSummarySchema, worktree],
    [RemoteAgentRunSchema, agent],
  ])("rejects sensitive local fields from projected DTOs", (schema, value) => {
    for (const [key, sensitiveValue] of [
      ["cwd", "/Users/example/project"],
      ["path", "/Users/example/project"],
      ["environment", { TOKEN: "secret" }],
      ["command", "agent --dangerously-skip-permissions"],
      ["token", "secret"],
      ["rendererState", { selectedPanelId: "panel-01" }],
      ["transcript", "a reconstructed conversation"],
      ["conversationDatabase", { messages: [] }],
      ["processSurvivesRestart", true],
      ["hostStoresTranscript", true],
    ] as const) {
      expect(schema.safeParse({ ...value, [key]: sensitiveValue }).success).toBe(false);
    }
  });

  it("rejects launch and prompt authority fields outside the explicit remote contract", () => {
    const launch = {
      projectId: project.id,
      worktreeId: worktree.id,
      agentId: agent.agentId,
      requestedPanelId: "requested-panel-01",
      idempotencyKey: "launch-01",
    };
    const prompt = {
      projectId: project.id,
      worktreeId: worktree.id,
      panelId: agent.panelId,
      launchGeneration: agent.launchGeneration,
      idempotencyKey: "prompt-01",
      text: "Run the focused tests",
    };

    expect(RemoteLaunchAgentRequestSchema.safeParse({ ...launch, cwd: "/tmp/repo" }).success).toBe(
      false
    );
    expect(
      RemoteLaunchAgentRequestSchema.safeParse({ ...launch, launchFlags: ["--unsafe"] }).success
    ).toBe(false);
    expect(
      RemoteSubmitPromptRequestSchema.safeParse({ ...prompt, env: { TOKEN: "secret" } }).success
    ).toBe(false);
  });

  it("accepts opaque stable identifiers and rejects path-like or whitespace-bearing identifiers", () => {
    expect(RemoteProjectSummarySchema.safeParse(project).success).toBe(true);
    expect(RemoteProjectSummarySchema.safeParse({ ...project, id: "/tmp/project" }).success).toBe(
      false
    );
    expect(RemoteProjectSummarySchema.safeParse({ ...project, id: "project id" }).success).toBe(
      false
    );
  });
});
