import { describe, expect, it } from "vitest";
import { buildOwnVoiceSessionDetails, type OwnVoiceSessionInput } from "../ownVoiceSessionDetails";
import type { PtyPanelData } from "@shared/types/panel";

const PANEL: PtyPanelData = {
  id: "p-1",
  kind: "terminal",
  title: "Claude · live title",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  location: "grid",
  launchAgentId: "claude",
};

function input(overrides: Partial<OwnVoiceSessionInput> = {}): OwnVoiceSessionInput {
  return {
    status: "recording",
    target: {
      panelId: "p-1",
      panelTitle: "claude · stale title",
      projectName: "Daintree",
      worktreeLabel: "main",
    },
    lockedPanelId: null,
    micSignal: "live",
    micDeviceLabel: "AirPods Pro",
    micNotice: null,
    correctionEnabled: false,
    buffer: undefined,
    panel: PANEL,
    hosts: [],
    clock: {
      provider: "deepgram",
      elapsedMs: 12_000,
      pausedMs: 0,
      autoStop: { reason: "idle", remainingMs: 100_000 },
    },
    ...overrides,
  };
}

describe("buildOwnVoiceSessionDetails (#14920)", () => {
  it.each(["idle", "error"] as const)("has nothing to show while %s", (status) => {
    expect(buildOwnVoiceSessionDetails(input({ status }))).toBeNull();
  });

  it("has nothing to show without a target", () => {
    expect(buildOwnVoiceSessionDetails(input({ target: null }))).toBeNull();
  });

  it("names the target by its live title, with the agent's identity", () => {
    const details = buildOwnVoiceSessionDetails(input())!;
    expect(details.targetTitle).toBe("Claude · live title");
    expect(details.targetChrome?.agentId).toBe("claude");
    expect(details.kind).toBe("dictation");
    expect(details.providerName).toBe("Deepgram");
    expect(details.elapsedMs).toBe(12_000);
  });

  it("falls back to the target's own title once the panel is gone", () => {
    const details = buildOwnVoiceSessionDetails(input({ panel: undefined }))!;
    expect(details.targetTitle).toBe("claude · stale title");
    expect(details.targetChrome).toBeNull();
  });

  it("names a Canopy reply as one, with no pane behind it", () => {
    const details = buildOwnVoiceSessionDetails(
      input({
        target: { panelId: "canopy-reply:run-1", surface: "canopy-reply" },
        panel: undefined,
      })
    )!;
    expect(details.kind).toBe("canopy-reply");
    expect(details.targetTitle).toBe("Canopy reply");
  });

  it("counts finished and interim words together", () => {
    const details = buildOwnVoiceSessionDetails(
      input({
        buffer: {
          liveText: "still speaking",
          liveItems: [],
          completedSegments: ["Add a test.", "Then run it."],
          sessionDraftStart: -1,
          activeParagraphStart: -1,
          transcriptPhase: "interim",
          correctionRanges: [],
          sessionCorrectedText: null,
          dictationSessionId: null,
        },
      })
    )!;
    expect(details.transcript.endsWith("still speaking")).toBe(true);
    expect(details.transcript.startsWith("Add a test.")).toBe(true);
    expect(details.wordCount).toBe(8);
  });

  it("shows a mic notice only for this session's target", () => {
    const otherTarget = { panelId: "p-9" };
    expect(
      buildOwnVoiceSessionDetails(
        input({ micNotice: { kind: "lost", target: otherTarget, deviceLabel: null } })
      )!.micNotice
    ).toBeNull();
    expect(
      buildOwnVoiceSessionDetails(
        input({
          micSignal: "silent",
          micNotice: {
            kind: "silent",
            target: { panelId: "p-1" },
            deviceLabel: "AirPods Pro",
            bluetooth: true,
            builtIn: null,
          },
        })
      )!.micNotice
    ).toEqual({ kind: "silent", bluetooth: true });
    expect(
      buildOwnVoiceSessionDetails(
        input({
          micSignal: "silent",
          micNotice: {
            kind: "silent",
            target: { panelId: "p-1" },
            deviceLabel: "Blue Yeti",
            bluetooth: false,
            builtIn: null,
            appReplaced: true,
          },
        })
      )!.micNotice
    ).toEqual({ kind: "silent", bluetooth: false, appReplaced: true });
  });

  it("says the target is locked only when the lock is on it", () => {
    expect(buildOwnVoiceSessionDetails(input({ lockedPanelId: "p-1" }))!.locked).toBe(true);
    expect(buildOwnVoiceSessionDetails(input({ lockedPanelId: "p-2" }))!.locked).toBe(false);
  });

  it("drops the clock once the session stops keeping one", () => {
    const details = buildOwnVoiceSessionDetails(input({ status: "finishing", clock: null }))!;
    expect(details.elapsedMs).toBeNull();
    expect(details.autoStop).toBeNull();
    expect(details.providerName).toBeNull();
  });
});
