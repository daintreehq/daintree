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
const sendNow = vi.hoisted(() =>
  vi.fn<
    (terminalId: string, token: string, inputBlocked: boolean) => Promise<{ outcome: string }>
  >()
);
vi.mock("@/clients/composerHoldClient", () => ({ composerHoldClient: { withdraw, sendNow } }));

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
  sendNow.mockReset().mockResolvedValue({ outcome: "sending" });
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
      "Send it now, edit it or withdraw it to send another"
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

  it("offers the text to copy, not to edit, when the pane has no composer", async () => {
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
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("held text"));
  });

  it("keeps Withdraw but not Edit for a held send the pane can't edit into", () => {
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit={false} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw held message" })).toBeTruthy();
  });

  it("sends it now, from the keyboard as well as the pointer, leaving the draft alone", async () => {
    drafts.set("t1", "a newer thought");
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    const button = screen.getByRole("button", { name: "Send now" });
    // A native button: Tab reaches it, and Enter and Space press it.
    expect(button.tagName).toBe("BUTTON");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(sendNow).toHaveBeenCalledWith("t1", "token-1", false));
    expect(withdraw).not.toHaveBeenCalled();
    expect(drafts.get("t1")).toBe("a newer thought");
  });

  it("offers Send now where the pane has no composer to edit into", () => {
    useHeldComposerSendStore.getState().noteHeld(send());
    useHeldComposerSendStore.getState().noteRefused("t1");
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit={false} />);
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(screen.getByTestId("held-composer-send").textContent).toContain(
      "Send it now or withdraw it to send another"
    );
  });

  it("tells main the panel can't take input, and keeps the text once it drops the send", async () => {
    sendNow.mockImplementation(async () => {
      useHeldComposerSendStore.getState().applyChange({
        terminalId: "t1",
        held: null,
        ended: {
          token: "token-1",
          outcome: { kind: "dropped", reason: "input-blocked" },
          text: "held text",
        },
      });
      return { outcome: "dropped" };
    });
    useHeldComposerSendStore.getState().noteHeld(send({ text: "held text" }));
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit inputBlocked />);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(sendNow).toHaveBeenCalledWith("t1", "token-1", true));
    await waitFor(() => expect(screen.getByTestId("held-composer-send-dropped")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(drafts.get("t1")).toBe("held text");
  });

  it("takes no second press while one is on its way, and offers them again if it fails", async () => {
    let fail!: (err: Error) => void;
    sendNow.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    const button = screen.getByRole("button", { name: "Send now" });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw held message" }));
    expect(sendNow).toHaveBeenCalledTimes(1);
    expect(withdraw).not.toHaveBeenCalled();

    await act(async () => fail(new Error("ipc down")));
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("held-composer-send")).toBeTruthy();
  });

  it.each(["question", "approval"])(
    "says before sending that the text goes into the %s the pane was last seen at",
    (reason) => {
      pane("waiting", reason);
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Send now" });
      const hintId = button.getAttribute("aria-describedby");
      expect(hintId).toBeTruthy();
      expect(document.getElementById(hintId!)?.textContent).toContain(`into that ${reason}`);
      expect(sendNow).not.toHaveBeenCalled();
    }
  );

  it("adds no such warning while the pane works or waits at its prompt", () => {
    for (const [state, reason] of [["working"], ["waiting", "prompt"], ["waiting", "error"]]) {
      pane(state!, reason);
      useHeldComposerSendStore.getState().noteHeld(send());
      const { unmount } = render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      expect(
        screen.getByRole("button", { name: "Send now" }).getAttribute("aria-describedby")
      ).toBeNull();
      expect(screen.getByTestId("held-composer-send").textContent).not.toContain("into that");
      unmount();
    }
  });
});
