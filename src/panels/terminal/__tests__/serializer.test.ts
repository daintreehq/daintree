// @vitest-environment node
import { describe, it, expect } from "vitest";
import { serializePtyPanel } from "../serializer";
import type { PtyPanelData } from "@shared/types/panel";

function makePanel(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "p1",
    title: "Claude",
    kind: "terminal",
    type: "claude",
    agentId: "claude",
    cwd: "/project",
    location: "grid",
    ...overrides,
  } as PtyPanelData;
}

describe("serializePtyPanel — agentPresetId", () => {
  it("includes agentPresetId in the snapshot when set", () => {
    const panel = makePanel({ agentPresetId: "user-abc123" });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.agentPresetId).toBe("user-abc123");
  });

  it("includes CCR preset IDs as well as custom ones", () => {
    const panel = makePanel({ agentPresetId: "ccr-some-route" });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.agentPresetId).toBe("ccr-some-route");
  });

  it("omits agentPresetId when it is undefined", () => {
    const panel = makePanel({ agentPresetId: undefined });
    const snapshot = serializePtyPanel(panel);
    expect("agentPresetId" in snapshot).toBe(false);
  });

  it("omits agentPresetId when it is an empty string", () => {
    const panel = makePanel({ agentPresetId: "" });
    const snapshot = serializePtyPanel(panel);
    expect("agentPresetId" in snapshot).toBe(false);
  });
});

describe("serializePtyPanel — other fields are unaffected by agentPresetId", () => {
  it("still serializes agentSessionId alongside agentPresetId", () => {
    const panel = makePanel({
      agentPresetId: "user-xyz",
      agentSessionId: "sess-999",
    });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.agentPresetId).toBe("user-xyz");
    expect(snapshot.agentSessionId).toBe("sess-999");
  });

  it("still serializes agentModelId alongside agentPresetId", () => {
    const panel = makePanel({
      agentPresetId: "user-xyz",
      agentModelId: "claude-sonnet-4-6",
    });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.agentPresetId).toBe("user-xyz");
    expect(snapshot.agentModelId).toBe("claude-sonnet-4-6");
  });

  it("still serializes agentLaunchFlags alongside agentPresetId", () => {
    const panel = makePanel({
      agentPresetId: "user-xyz",
      agentLaunchFlags: ["--dangerously-skip-permissions"],
    });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.agentPresetId).toBe("user-xyz");
    expect(snapshot.agentLaunchFlags).toEqual(["--dangerously-skip-permissions"]);
  });
});

// ── adversarial: agentPresetColor must survive the serialise/restore round-trip ─
// Bug: serializePtyPanel does not write agentPresetColor into the snapshot.
// After an Electron reload the panel re-opens with agentPresetColor=undefined,
// so the dock icon loses its preset-derived mark ink and falls back to the default brand color —
// even when the preset is still present in settings.

describe("serializePtyPanel — agentPresetColor (Bug: not serialized)", () => {
  it("includes agentPresetColor in the snapshot when set", () => {
    const panel = makePanel({ agentPresetColor: "#ff6600" });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.agentPresetColor).toBe("#ff6600");
  });

  it("omits agentPresetColor when it is undefined", () => {
    const panel = makePanel({ agentPresetColor: undefined });
    const snapshot = serializePtyPanel(panel);
    expect("agentPresetColor" in snapshot).toBe(false);
  });

  it("serializes both agentPresetId and agentPresetColor together", () => {
    const panel = makePanel({ agentPresetId: "user-abc", agentPresetColor: "#aabbcc" });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.agentPresetId).toBe("user-abc");
    expect(snapshot.agentPresetColor).toBe("#aabbcc");
  });

  // Forward-only write contract for issue #5459: the serializer must never
  // emit the legacy agentFlavorId / agentFlavorColor keys. The hydration path
  // (statePatcher.ts) tolerates them on read for backward compat, but writes
  // must be clean so old keys age out of project JSON on the next save.
  it("never writes legacy agentFlavorId or agentFlavorColor keys", () => {
    const panel = makePanel({ agentPresetId: "user-abc", agentPresetColor: "#aabbcc" });
    const snapshot = serializePtyPanel(panel) as Record<string, unknown>;
    expect("agentFlavorId" in snapshot).toBe(false);
    expect("agentFlavorColor" in snapshot).toBe(false);
  });
});

// Launch env persistence (#10922): a terminal launched via a preset/recipe
// pointing Claude Code at an alternate provider (Z.AI/GLM) must replay the same
// provider env on restore. The serializer captures the sanitized launch env so
// the restored session doesn't silently fall back to the default provider.
describe("serializePtyPanel — launch env (#10922)", () => {
  it("serializes safe provider env keys into the snapshot", () => {
    const panel = makePanel({
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2",
      },
    });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2",
    });
  });

  it("omits env entirely when the panel carries none", () => {
    const snapshot = serializePtyPanel(makePanel());
    expect("env" in snapshot).toBe(false);
  });

  it("strips dangerous keys and injection values, keeping safe ones", () => {
    const panel = makePanel({
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        PATH: "/evil/bin",
        EVIL: "$(rm -rf /)",
      } as Record<string, string>,
    });
    const snapshot = serializePtyPanel(panel);
    expect(snapshot.env).toEqual({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" });
  });

  it("omits env when sanitization leaves nothing safe", () => {
    const panel = makePanel({ env: { PATH: "/evil/bin" } as Record<string, string> });
    const snapshot = serializePtyPanel(panel);
    expect("env" in snapshot).toBe(false);
  });
});

// "directing" is a renderer-only ephemeral state owned by
// TerminalAgentStateController (#5832). Persisting it could resurrect a stuck
// indicator on the next reload because setAgentState explicitly ignores
// incoming "directing" values, so the controller cannot sanitize the panel
// store entry through its normal IPC path.
describe("serializePtyPanel — directing is never persisted", () => {
  it("omits agentState entirely when set to directing", () => {
    const panel = makePanel({ agentState: "directing" });
    const snapshot = serializePtyPanel(panel) as Record<string, unknown>;
    expect("agentState" in snapshot).toBe(false);
  });

  it("still persists non-directing agent states", () => {
    for (const state of ["working", "waiting", "completed", "exited"] as const) {
      const panel = makePanel({ agentState: state });
      const snapshot = serializePtyPanel(panel);
      expect(snapshot.agentState).toBe(state);
    }
  });
});

// Runtime detection identity (#5768) is recomputed by the backend detector on
// every PTY attach — it must not be persisted into project JSON.
describe("serializePtyPanel — detectedAgentId is never persisted", () => {
  it("omits detectedAgentId even when the panel currently carries one", () => {
    const panel = makePanel({ detectedAgentId: "claude" });
    const snapshot = serializePtyPanel(panel) as Record<string, unknown>;
    expect("detectedAgentId" in snapshot).toBe(false);
  });
});

// `lastActiveAt` (#8703) is the focus-stamp used by the restore predicate.
// Since #8957 step 6 the field lives on BasePanelData and is written by the
// base layer in panelToSnapshot, not by per-kind serializers — coverage
// lives in panelPersistence tests instead.

// sessionLostOnRestore (#9802) is a transient restore-time signal. Persisting it
// would resurface the "Session no longer reachable" banner on every subsequent
// restart, so the serializer must never write it into project JSON.
describe("serializePtyPanel — sessionLostOnRestore is never persisted", () => {
  it("omits sessionLostOnRestore even when the panel currently carries it", () => {
    const panel = makePanel({ sessionLostOnRestore: "no-resume-command" });
    const snapshot = serializePtyPanel(panel) as Record<string, unknown>;
    expect("sessionLostOnRestore" in snapshot).toBe(false);
  });
});

// `worktreeMoveNotice` (#11853) asks the user to say something to a running
// agent. Persisting it would put the bar back in front of a process that no
// longer exists, offering to redirect a session the restart already replaced.
describe("serializePtyPanel — worktreeMoveNotice is never persisted", () => {
  it("omits worktreeMoveNotice even when the panel currently carries it", () => {
    const panel = makePanel({ worktreeMoveNotice: { destinationWorktreeId: "wt-b" } });
    const snapshot = serializePtyPanel(panel) as Record<string, unknown>;
    expect("worktreeMoveNotice" in snapshot).toBe(false);
  });
});

// A session-id-assigning flag is spent the moment the CLI accepts it (#11782).
// Persisting it would hand a rejected launch to any restore that replays the
// stored command, so the command is persisted without it while the id itself
// still is — that pairing is what lets restore rebuild a working resume.
describe("serializePtyPanel — an assigned session id never persists in the command", () => {
  const sessionId = "12345678-1234-1234-1234-123456789abc";

  it("drops the assigning flag but keeps the id and the rest of the command", () => {
    const panel = makePanel({
      launchAgentId: "claude",
      agentSessionId: sessionId,
      command: `claude --session-id ${sessionId} --verbose`,
    });

    const snapshot = serializePtyPanel(panel);

    expect(snapshot.command).not.toContain("--session-id");
    expect(snapshot.command).not.toContain(sessionId);
    expect(snapshot.command).toContain("--verbose");
    // The id survives on its own field — that is what restore resumes from.
    expect(snapshot.agentSessionId).toBe(sessionId);
  });

  it("leaves a command that never carried the flag untouched", () => {
    const panel = makePanel({
      launchAgentId: "claude",
      agentSessionId: sessionId,
      command: "claude --verbose",
    });
    expect(serializePtyPanel(panel).command).toBe("claude --verbose");
  });

  it("leaves an agent that mints its own id untouched", () => {
    const panel = makePanel({
      launchAgentId: "codex",
      agentSessionId: sessionId,
      command: `codex --session-id ${sessionId}`,
    });
    // Codex declares no assigning args, so nothing here is a spent flag.
    expect(serializePtyPanel(panel).command).toBe(`codex --session-id ${sessionId}`);
  });

  it("strips even when the panel no longer carries the id", () => {
    // The id can be cleared before the panel is serialized; the flag still has
    // to go, or the restore replays a launch the CLI will reject.
    const panel = makePanel({
      launchAgentId: "claude",
      agentSessionId: undefined,
      command: `claude --session-id '${sessionId}'`,
    });
    expect(serializePtyPanel(panel).command).toBe("claude");
  });
});
