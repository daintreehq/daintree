// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { __resetFleetTargetOverridesStoreForTesting } from "@/store/fleetTargetOverridesStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetRunStore } from "@/store/fleetRunStore";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";

const submitMock = vi.fn<(id: string, text: string) => Promise<void>>();
const submitCrossHostMock = vi.fn<(key: string, text: string) => Promise<void>>();

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      submit: (id: string, text: string) => submitMock(id, text),
    },
  };
});

vi.mock("@/components/Fleet/crossHostFleet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Fleet/crossHostFleet")>();
  return {
    ...actual,
    submitCrossHostTarget: (key: string, text: string) => submitCrossHostMock(key, text),
  };
});

import {
  _resetCrossHostFleetForTesting,
  armCrossHostTarget,
} from "@/components/Fleet/crossHostFleet";
import { tryComposerFleetBroadcast } from "../composerFleetBroadcast";

function armLocal(id: string): void {
  const panel = {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
  } as PtyPanelData;
  usePanelStore.setState({ panelsById: { [id]: panel }, panelIds: [id] });
  useFleetArmingStore.getState().armIds([id]);
}

beforeEach(() => {
  submitMock.mockReset().mockResolvedValue(undefined);
  submitCrossHostMock.mockReset().mockResolvedValue(undefined);
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  _resetCrossHostFleetForTesting();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useFleetBroadcastProgressStore.setState({
    completed: 0,
    total: 0,
    failed: 0,
    isActive: false,
    cancelled: false,
  });
  __resetFleetTargetOverridesStoreForTesting();
  useFleetRunStore.getState()._reset();
  Object.assign(window, {
    electron: {
      notification: { playUiEvent: vi.fn().mockResolvedValue(undefined) },
      runHistory: { append: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

describe("Enter in an armed composer", () => {
  it("sends as usual when its pane is armed alone", () => {
    armLocal("t-1");
    const onSent = vi.fn();
    expect(tryComposerFleetBroadcast(true, "t-1", "hello", onSent)).toBe(false);
    expect(onSent).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("broadcasts when the only other armed agent is on another host", async () => {
    armLocal("t-1");
    armCrossHostTarget({
      hostId: "studio-01",
      hostName: "studio-01",
      terminalId: "remote-1",
      title: "remote agent",
    });
    const onSent = vi.fn();
    expect(tryComposerFleetBroadcast(true, "t-1", "hello", onSent)).toBe(true);
    await vi.waitFor(() => expect(submitCrossHostMock).toHaveBeenCalled());
    expect(submitMock).toHaveBeenCalledWith("t-1", expect.stringContaining("hello"));
    expect(submitCrossHostMock.mock.calls[0]![1]).toContain("hello");
  });

  it("leaves a pane that isn't focused, or isn't armed, alone", () => {
    armLocal("t-1");
    armCrossHostTarget({
      hostId: "studio-01",
      hostName: "studio-01",
      terminalId: "remote-1",
      title: "remote agent",
    });
    expect(tryComposerFleetBroadcast(false, "t-1", "hello", vi.fn())).toBe(false);
    expect(tryComposerFleetBroadcast(true, "t-2", "hello", vi.fn())).toBe(false);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe("the composer's send", () => {
  it("lets the broadcast decide, rather than counting only this view's armed panes", () => {
    const source = readFileSync(path.resolve(__dirname, "../HybridInputBar.tsx"), "utf8");
    const start = source.indexOf("const sendFromEditor = () => {");
    const end = source.indexOf("sendText(text);", start);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);
    expect(body).toContain("tryComposerFleetBroadcast(isFocusedTerminal, terminalId, text,");
    expect(body).not.toMatch(/armedIds\.size/);
  });
});
