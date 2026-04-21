// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastFleetKeySequence, broadcastFleetLiteralPaste } from "../fleetExecution";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import type { TerminalInstance } from "@shared/types";

const writeMock = vi.fn<(id: string, data: string) => void>();
const submitMock = vi.fn<(id: string, text: string) => Promise<void>>();

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      write: (id: string, data: string) => writeMock(id, data),
      submit: (id: string, text: string) => submitMock(id, text),
    },
  };
});

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    type: "terminal",
    kind: "agent",
    agentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

function armTwo() {
  usePanelStore.setState({
    panelsById: { t1: makeAgent("t1"), t2: makeAgent("t2") },
    panelIds: ["t1", "t2"],
  });
  useFleetArmingStore.getState().armIds(["t1", "t2"]);
}

function reset() {
  writeMock.mockReset();
  submitMock.mockReset();
  submitMock.mockResolvedValue(undefined);
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

describe("broadcastFleetKeySequence", () => {
  beforeEach(() => {
    reset();
  });

  it("resolves armed targets fresh when no target list is given", () => {
    armTwo();
    broadcastFleetKeySequence("\r");

    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock.mock.calls.map(([id, seq]) => [id, seq]).sort()).toEqual([
      ["t1", "\r"],
      ["t2", "\r"],
    ]);
  });

  it("respects a caller-supplied target list verbatim", () => {
    armTwo();
    broadcastFleetKeySequence("x", ["t2"]);

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]).toEqual(["t2", "x"]);
  });

  it("no-ops cleanly with zero targets", () => {
    broadcastFleetKeySequence("\x1b");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("does NOT apply recipe-variable substitution to the sequence", () => {
    armTwo();
    broadcastFleetKeySequence("{{branch_name}}");
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock.mock.calls[0]![1]).toBe("{{branch_name}}");
    expect(writeMock.mock.calls[1]![1]).toBe("{{branch_name}}");
  });
});

describe("broadcastFleetLiteralPaste", () => {
  beforeEach(() => {
    reset();
  });

  it("submits verbatim paste text to each target (no recipe substitution)", async () => {
    armTwo();
    const result = await broadcastFleetLiteralPaste("hello {{branch_name}}");
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(submitMock.mock.calls.map(([, text]) => text)).toEqual([
      "hello {{branch_name}}",
      "hello {{branch_name}}",
    ]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it("collects failures into failedIds without rejecting the aggregate", async () => {
    submitMock.mockReset();
    submitMock.mockResolvedValueOnce(undefined);
    submitMock.mockRejectedValueOnce(new Error("nope"));
    armTwo();

    const result = await broadcastFleetLiteralPaste("x");
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.failedIds).toEqual(["t2"]);
  });

  it("returns an empty result on zero targets", async () => {
    const result = await broadcastFleetLiteralPaste("x");
    expect(submitMock).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.successCount).toBe(0);
  });
});
