// @vitest-environment node
import { describe, it, expect } from "vitest";
import { serializePtyPanel } from "../serializer";
import type { PtyPanelData } from "@shared/types/panel";

function makePanel(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "p1",
    title: "Claude",
    kind: "agent",
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
// so the dock icon loses its tint and falls back to the default brand color —
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

// Runtime detection identity (#5768) is recomputed by the backend detector on
// every PTY attach — it must not be persisted into project JSON.
describe("serializePtyPanel — detectedAgentId is never persisted", () => {
  it("omits detectedAgentId even when the panel currently carries one", () => {
    const panel = makePanel({ detectedAgentId: "claude" });
    const snapshot = serializePtyPanel(panel) as Record<string, unknown>;
    expect("detectedAgentId" in snapshot).toBe(false);
  });
});
