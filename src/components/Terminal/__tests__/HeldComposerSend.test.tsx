// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeldComposerSend } from "@shared/types/ipc/composerHold";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const withdraw = vi.hoisted(() => vi.fn<(terminalId: string, token: string) => Promise<boolean>>());
vi.mock("@/clients/composerHoldClient", () => ({ composerHoldClient: { withdraw } }));

const requestPaneFocus = vi.hoisted(() => vi.fn());
vi.mock("../paneFocusRequest", () => ({ requestPaneFocus }));

const panels = vi.hoisted(() => ({ byId: {} as Record<string, unknown> }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: { panelsById: Record<string, unknown> }) => unknown) =>
    selector({ panelsById: panels.byId }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: { id: string } }) => unknown) =>
    selector({ currentProject: { id: "project-1" } }),
}));

const drafts = vi.hoisted(() => new Map<string, string>());
const inputs = vi.hoisted(() => ({
  getDraftInput: (terminalId: string) => drafts.get(terminalId) ?? "",
  setDraftInput: (terminalId: string, value: string) => drafts.set(terminalId, value),
  bumpExternalDraftRevision: vi.fn(),
}));
vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => inputs },
}));

import { HeldComposerSendRow } from "../HeldComposerSend";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";

function send(overrides: Partial<HeldComposerSend> = {}): HeldComposerSend {
  return {
    terminalId: "t1",
    token: "token-1",
    text: "fix the failing tests\nand rerun them",
    imagePaths: [],
    heldAt: 1,
    expiresAt: 2,
    status: "held",
    ...overrides,
  };
}

function pane(agentState: string, waitingReason?: string) {
  panels.byId = { t1: { id: "t1", kind: "terminal", agentState, waitingReason } };
}

beforeEach(() => {
  useHeldComposerSendStore.setState({ held: {}, dropped: {}, refused: {}, endedTokens: [] });
  withdraw.mockReset();
  requestPaneFocus.mockReset();
  inputs.bumpExternalDraftRevision.mockReset();
  drafts.clear();
  pane("working");
});

describe("HeldComposerSendRow", () => {
  it("shows nothing while nothing is held or dropped", () => {
    const { container } = render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(container.textContent).toBe("");
  });

  it("says what the send waits for and shows its first line", () => {
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    const row = screen.getByTestId("held-composer-send");
    expect(row.textContent).toContain("back at its prompt");
    expect(row.textContent).toContain("fix the failing tests");
    expect(row.textContent).not.toContain("rerun them");
  });

  it("says when the pane waits on a question rather than its prompt", () => {
    pane("waiting", "question");
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(screen.getByTestId("held-composer-send").textContent).toContain(
      "waiting on a question, not its prompt"
    );
  });

  it("puts the text back ahead of a newer draft once withdrawn for editing", async () => {
    withdraw.mockResolvedValue(true);
    drafts.set("t1", "a newer thought");
    useHeldComposerSendStore.getState().noteHeld(send({ text: "held text" }));
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(drafts.get("t1")).toBe("held text\n\na newer thought"));
    expect(inputs.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
    expect(withdraw).toHaveBeenCalledWith("t1", "token-1");
    expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput");
  });

  it("leaves the draft alone when the send was already on its way", async () => {
    withdraw.mockResolvedValue(false);
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(withdraw).toHaveBeenCalledTimes(1));
    expect(drafts.has("t1")).toBe(false);
  });

  it("withdraws without touching the draft", async () => {
    withdraw.mockResolvedValue(true);
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    fireEvent.click(screen.getByRole("button", { name: "Withdraw held message" }));
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith("t1", "token-1"));
    expect(drafts.has("t1")).toBe(false);
  });

  it("offers nothing to press once the send is on its way", () => {
    useHeldComposerSendStore.getState().noteHeld(send({ status: "sending" }));
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("says a second send waits on this one", () => {
    useHeldComposerSendStore.getState().noteHeld(send());
    useHeldComposerSendStore.getState().noteRefused("t1");
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(screen.getByTestId("held-composer-send").textContent).toContain(
      "Edit or withdraw it to send another"
    );
  });

  it("says why a dropped send wasn't sent, and gives its text back", () => {
    useHeldComposerSendStore.getState().noteHeld(send({ text: "held text" }));
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    act(() =>
      useHeldComposerSendStore.getState().applyChange({
        terminalId: "t1",
        held: null,
        ended: { token: "token-1", outcome: { kind: "dropped", reason: "typed" } },
      })
    );
    const row = screen.getByTestId("held-composer-send-dropped");
    expect(row.textContent).toContain("input reached the terminal first");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(drafts.get("t1")).toBe("held text");
    expect(inputs.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("held-composer-send-dropped")).toBeNull();
  });

  it("offers the text to copy, not to edit, when the pane has no composer", () => {
    useHeldComposerSendStore.getState().applyChange({
      terminalId: "t1",
      held: null,
      ended: {
        token: "token-1",
        outcome: { kind: "dropped", reason: "ended" },
        text: "held text",
      },
    });
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit={false} />);
    expect(screen.getByTestId("held-composer-send-dropped").textContent).toContain(
      "the agent's terminal ended"
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("keeps Withdraw but not Edit for a held send the pane can't edit into", () => {
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit={false} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw held message" })).toBeTruthy();
  });
});
