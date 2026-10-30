// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalFirstPrompt } from "@shared/types/panel";
import type { TerminalFirstPromptPayload } from "@shared/types/pty-host";

const { saveNormalized, firstPromptHandlers, unsubscribe } = vi.hoisted(() => ({
  saveNormalized: vi.fn(),
  firstPromptHandlers: [] as Array<(payload: TerminalFirstPromptPayload) => void>,
  unsubscribe: vi.fn(),
}));

vi.mock("@/store/slices/panelRegistry/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/slices/panelRegistry/persistence")>()),
  saveNormalized,
}));
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      onFirstPrompt: vi.fn((handler: (payload: TerminalFirstPromptPayload) => void) => {
        firstPromptHandlers.push(handler);
        return unsubscribe;
      }),
    },
  };
});

import { usePanelStore } from "@/store/panelStore";
import {
  beginBatch,
  consumeBatch,
  resetBatchState,
} from "@/store/slices/panelRegistry/hydrationBatch";
import { recordSentFirstPrompt, setupFirstPromptListeners } from "../firstPrompt";

const sent: TerminalFirstPrompt = { text: "Fix the login bug", via: "send", at: 5 };

const agentPane = {
  id: "t1",
  kind: "terminal" as const,
  title: "Claude",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  location: "grid" as const,
  launchAgentId: "claude",
};

function seed(overrides: Record<string, unknown> = {}): void {
  usePanelStore.setState({
    panelsById: { t1: { ...agentPane, ...overrides } as never },
    panelIds: ["t1"],
  });
}

function firstPromptOf(id: string): unknown {
  return (usePanelStore.getState().panelsById[id] as { firstPrompt?: unknown } | undefined)
    ?.firstPrompt;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBatchState();
  firstPromptHandlers.length = 0;
});

describe("recordSentFirstPrompt (#15521)", () => {
  it("records the first send on an agent pane without one, and saves it", () => {
    seed();

    recordSentFirstPrompt("t1", sent);

    expect(firstPromptOf("t1")).toEqual(sent);
    expect(saveNormalized).toHaveBeenCalledTimes(1);
  });

  it("keeps a record the pane already has", () => {
    const launched: TerminalFirstPrompt = { text: "Launch task", via: "launch", at: 1 };
    seed({ firstPrompt: launched });

    recordSentFirstPrompt("t1", sent);

    expect(firstPromptOf("t1")).toEqual(launched);
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("records nothing on a pane mid-restart, a shell, a trashed pane, or no pane", () => {
    for (const overrides of [
      { isRestarting: true },
      { launchAgentId: undefined },
      { location: "trash" },
    ]) {
      seed(overrides);
      recordSentFirstPrompt("t1", sent);
      expect(firstPromptOf("t1")).toBeUndefined();
    }
    recordSentFirstPrompt("missing", sent);
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("refuses a record that isn't a send", () => {
    seed();

    recordSentFirstPrompt("t1", { ...sent, via: "launch" });
    recordSentFirstPrompt("t1", { text: "  ", via: "send", at: 5 });

    expect(firstPromptOf("t1")).toBeUndefined();
  });

  it("leaves the save to the end of a hydration batch", () => {
    seed();
    const token = beginBatch();

    recordSentFirstPrompt("t1", sent);

    expect(firstPromptOf("t1")).toEqual(sent);
    expect(saveNormalized).not.toHaveBeenCalled();
    consumeBatch(token);
  });
});

describe("setupFirstPromptListeners", () => {
  it("records what main delivers and stops listening on dispose", () => {
    seed();
    const store = setupFirstPromptListeners();

    firstPromptHandlers.at(-1)?.({ id: "t1", firstPrompt: sent });
    expect(firstPromptOf("t1")).toEqual(sent);

    store.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
