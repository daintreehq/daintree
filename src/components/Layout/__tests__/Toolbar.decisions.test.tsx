// @vitest-environment jsdom
/**
 * The Decisions inbox button (#17236) through the real Toolbar: absent while
 * Decisions is off or not yet known, and in a Remote Host's window, and while
 * absent it reads no questions; on, it counts those waiting on the person.
 */
import "../__preview__/toolbarShims";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { CliAvailability } from "@shared/types";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";

const decisions = vi.hoisted(() => ({
  onStatus: null as ((status: DecisionsStatus) => void) | null,
  statusWatches: 0,
  onList: null as ((list: DecisionQuestionList) => void) | null,
  questionWatches: 0,
  remote: false,
}));

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: {
    watchStatus: (onStatus: (status: DecisionsStatus) => void) => {
      decisions.statusWatches += 1;
      decisions.onStatus = onStatus;
      return () => {
        decisions.onStatus = null;
      };
    },
    watchQuestions: (onList: (list: DecisionQuestionList) => void) => {
      decisions.questionWatches += 1;
      decisions.onList = onList;
      return () => {
        decisions.onList = null;
      };
    },
  },
}));

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ActionService")>();
  return { ...actual, actionService: { ...actual.actionService, dispatch: dispatchMock } };
});

vi.mock("@/hooks/useHostPlatform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useHostPlatform")>();
  return { ...actual, isRemoteWindow: () => decisions.remote };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { PREVIEW_PROJECT } from "../__preview__/toolbarShims";
import { Toolbar } from "../Toolbar";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";

const noop = () => {};

function Harness() {
  const projectSwitcherPalette = useProjectSwitcherPalette();
  return (
    <Toolbar
      onLaunchAgent={noop}
      onSettings={noop}
      hasWorkspace
      agentAvailability={{} as CliAvailability}
      projectSwitcherPalette={projectSwitcherPalette}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(): Promise<void> {
  initBuiltInPanelKinds();
  const worktreeStore = createWorktreeStore();
  worktreeStore.setState({
    worktrees: new Map([
      [
        "wt-main",
        {
          id: "wt-main",
          worktreeId: "wt-main",
          path: PREVIEW_PROJECT.path,
          name: "main",
          branch: "develop",
          isCurrent: true,
          isMainWorktree: true,
        },
      ],
    ]),
  } as never);
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-main" });
  useProjectStore.setState({ currentProject: PREVIEW_PROJECT });
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Harness />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await settle();
}

function reportStatus(state: DecisionsStatus["state"]): Promise<void> {
  act(() => decisions.onStatus?.({ state } as DecisionsStatus));
  return settle();
}

function question(id: string, standing: DecisionQuestionStanding): DecisionQuestionListItem {
  return {
    reference: { hostId: "local", projectId: "p1", terminalId: "t1", questionId: id },
    standing,
  } as DecisionQuestionListItem;
}

function listQuestions(questions: DecisionQuestionListItem[], revision = 1): Promise<void> {
  act(() => decisions.onList?.({ revision, questions }));
  return settle();
}

function inboxButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label^="Decisions inbox"]');
}

beforeEach(() => {
  Object.assign(decisions, {
    onStatus: null,
    statusWatches: 0,
    onList: null,
    questionWatches: 0,
    remote: false,
  });
  dispatchMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("Toolbar's Decisions inbox button", () => {
  it("is absent and reads no questions until Decisions is on, and while it is off", async () => {
    await mount();
    expect(inboxButton()).toBeNull();

    await reportStatus("off");
    expect(inboxButton()).toBeNull();
    expect(decisions.questionWatches).toBe(0);

    await reportStatus("connected");
    expect(inboxButton()).not.toBeNull();

    await reportStatus("off");
    expect(inboxButton()).toBeNull();
    // Off, the question watch the button held is stopped.
    expect(decisions.onList).toBeNull();
  });

  it("counts the questions waiting on the person, and nothing else", async () => {
    await mount();
    await reportStatus("connected");
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox");

    await listQuestions([
      question("q1", { kind: "waiting", reason: "open" }),
      question("q2", { kind: "waiting", reason: "reply" }),
      question("q3", { kind: "queued" }),
      question("q4", { kind: "to-type" }),
      question("q5", { kind: "needs-attention", deliveryStatus: "needs-attention" }),
      question("q6", { kind: "send-failed" }),
      question("q7", { kind: "settled", outcome: "answered", handled: false }),
    ]);
    const button = inboxButton()!;
    expect(button.getAttribute("aria-label")).toBe("Decisions inbox — 3 questions waiting");
    const badge = button.querySelector(".toolbar-count")!;
    expect(badge.getAttribute("data-visible")).toBe("true");
    expect(badge.textContent).toBe("3");

    // One answered: it leaves the count.
    await listQuestions(
      [
        question("q1", { kind: "settled", outcome: "answered", handled: false }),
        question("q2", { kind: "waiting", reason: "reply" }),
      ],
      2
    );
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox — 1 question waiting");

    await listQuestions([], 3);
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Decisions inbox");
    expect(inboxButton()!.querySelector(".toolbar-count")!.getAttribute("data-visible")).toBe(
      "false"
    );
  });

  it("opens the inbox through its action", async () => {
    await mount();
    await reportStatus("connected");
    fireEvent.click(inboxButton()!);
    expect(dispatchMock).toHaveBeenCalledWith("decisions.openInbox", undefined, {
      source: "user",
    });
  });

  it("shares one question watch between the strip and its overflow reading", async () => {
    await mount();
    await reportStatus("connected");
    expect(decisions.questionWatches).toBe(1);
  });

  it("is absent from a Remote Host's window, which watches neither the switch nor the questions", async () => {
    decisions.remote = true;
    await mount();
    expect(inboxButton()).toBeNull();
    expect(decisions.statusWatches).toBe(0);
    expect(decisions.questionWatches).toBe(0);
  });
});
