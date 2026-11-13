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
// Advanced to stand for a press elsewhere, or anything newer steering the keyboard.
const focusEpoch = vi.hoisted(() => ({ value: 0 }));
vi.mock("../paneFocusRequest", () => ({
  requestPaneFocus,
  captureFocusEpoch: () => focusEpoch.value,
  isFocusEpochCurrent: (captured: number) => captured === focusEpoch.value,
}));

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
// Keyed as the store keys drafts, so a restore read or written outside the
// pane's project scope misses the composer's draft.
const draftKey = vi.hoisted(
  () => (terminalId: string, projectId?: string) =>
    projectId ? `${projectId}:${terminalId}` : terminalId
);
const inputs = vi.hoisted(() => ({
  hybridInputAutoFocus: true,
  getDraftInput: (terminalId: string, projectId?: string) =>
    drafts.get(draftKey(terminalId, projectId)) ?? "",
  setDraftInput: (terminalId: string, value: string, projectId?: string) =>
    drafts.set(draftKey(terminalId, projectId), value),
  bumpExternalDraftRevision: vi.fn(),
}));
vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => inputs },
  selectHomeFocusTarget: (state: { hybridInputAutoFocus: boolean }) =>
    state.hybridInputAutoFocus ? "hybridInput" : "xterm",
}));

import { HeldComposerSendRow } from "../HeldComposerSend";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import {
  _resetPendingComposerImagesForTesting,
  takePendingComposerImages,
} from "@/lib/composerPendingImages";

/** The pane's draft, in the current project's scope. */
const KEY = "project-1:t1";

/** What the pane's composer is left to put back on the restored text. */
const pendingImages = (draft: string) => takePendingComposerImages(KEY, draft);

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
  inputs.hybridInputAutoFocus = true;
  drafts.clear();
  _resetPendingComposerImagesForTesting();
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

  it("says when the pane waits on a choice dialog, which would take the text as a choice", () => {
    pane("waiting", "approval");
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(screen.getByTestId("held-composer-send").textContent).toContain(
      "waiting on a choice dialog, not its prompt"
    );
  });

  it("puts the text back ahead of a newer draft once withdrawn for editing", async () => {
    withdraw.mockResolvedValue(true);
    drafts.set(KEY, "a newer thought");
    useHeldComposerSendStore.getState().noteHeld(send({ text: "held text" }));
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(drafts.get(KEY)).toBe("held text\n\na newer thought"));
    expect(inputs.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
    expect(withdraw).toHaveBeenCalledWith("t1", "token-1");
    expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput");
    expect(pendingImages("held text\n\na newer thought")).toEqual({
      draft: "held text\n\na newer thought",
      before: "a newer thought",
      change: { from: 0, to: 0, insert: "held text\n\n" },
      images: [],
    });
  });

  it("puts a held send's images back with its text, ahead of a newer draft", async () => {
    withdraw.mockResolvedValue(true);
    drafts.set(KEY, "a newer thought");
    const text = "compare /tmp/a.png with /tmp/b.png";
    useHeldComposerSendStore
      .getState()
      .noteHeld(send({ text, imagePaths: ["/tmp/a.png", "/tmp/b.png"] }));
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(screen.getByTestId("held-composer-send").textContent).toContain("· 2 images");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const draft = `${text}\n\na newer thought`;
    await waitFor(() => expect(drafts.get(KEY)).toBe(draft));
    expect(pendingImages(draft)?.images).toEqual([
      { from: 8, to: 18, filePath: "/tmp/a.png" },
      { from: 24, to: 34, filePath: "/tmp/b.png" },
    ]);
  });

  it("leaves the draft alone when the send was already on its way", async () => {
    withdraw.mockResolvedValue(false);
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(withdraw).toHaveBeenCalledTimes(1));
    expect(drafts.has(KEY)).toBe(false);
  });

  it("withdraws without touching the draft", async () => {
    withdraw.mockResolvedValue(true);
    useHeldComposerSendStore.getState().noteHeld(send());
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    fireEvent.click(screen.getByRole("button", { name: "Withdraw held message" }));
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith("t1", "token-1"));
    expect(drafts.has(KEY)).toBe(false);
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
    expect(drafts.get(KEY)).toBe("held text");
    expect(inputs.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("held-composer-send-dropped")).toBeNull();
    expect(pendingImages("held text")).toEqual({
      draft: "held text",
      before: "",
      change: { from: 0, to: 0, insert: "held text" },
      images: [],
    });
  });

  it("gives a dropped send's images back with its text, over a blank draft", () => {
    drafts.set(KEY, "  ");
    useHeldComposerSendStore.getState().applyChange({
      terminalId: "t1",
      held: null,
      ended: {
        token: "token-1",
        outcome: { kind: "dropped", reason: "restarted" },
        text: "/tmp/a.png then /tmp/a.png again",
        imagePaths: ["/tmp/a.png", "/tmp/a.png"],
      },
    });
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const draft = "/tmp/a.png then /tmp/a.png again";
    expect(drafts.get(KEY)).toBe(draft);
    expect(pendingImages(draft)).toEqual({
      draft,
      before: "  ",
      change: { from: 0, to: 2, insert: draft },
      images: [
        { from: 0, to: 10, filePath: "/tmp/a.png" },
        { from: 16, to: 26, filePath: "/tmp/a.png" },
      ],
    });
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
    drafts.set(KEY, "a newer thought");
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
    expect(drafts.get(KEY)).toBe("a newer thought");
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
    expect(drafts.get(KEY)).toBe("held text");
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

  it.each([
    ["question", "question"],
    ["approval", "choice dialog"],
  ])(
    "says before sending that the text goes into the %s the pane was last seen at",
    (reason, named) => {
      pane("waiting", reason);
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Send now" });
      const hintId = button.getAttribute("aria-describedby");
      expect(hintId).toBeTruthy();
      expect(document.getElementById(hintId!)?.textContent).toContain(`into that ${named}`);
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
  it("counts a dropped send's images beside its text, as a held one does", () => {
    useHeldComposerSendStore.getState().applyChange({
      terminalId: "t1",
      held: null,
      ended: {
        token: "token-1",
        outcome: { kind: "dropped", reason: "typed" },
        text: "look at /tmp/a.png and /tmp/b.png",
        imagePaths: ["/tmp/a.png", "/tmp/b.png"],
      },
    });
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(screen.getByTestId("held-composer-send-dropped").textContent).toContain(
      "look at /tmp/a.png and /tmp/b.png · 2 images"
    );
  });

  it("counts a single image singly, and says nothing without one", () => {
    useHeldComposerSendStore
      .getState()
      .noteHeld(send({ text: "see /tmp/a.png", imagePaths: ["/tmp/a.png"] }));
    const { unmount } = render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    expect(screen.getByTestId("held-composer-send").textContent).toContain(
      "see /tmp/a.png · 1 image"
    );
    unmount();

    useHeldComposerSendStore.setState({ held: {} });
    useHeldComposerSendStore.getState().applyChange({
      terminalId: "t1",
      held: null,
      ended: { token: "token-1", outcome: { kind: "dropped", reason: "typed" }, text: "plain" },
    });
    render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
    const preview = screen.getByTestId("held-composer-send-dropped").querySelector("p.truncate");
    expect(preview?.textContent).toBe("plain");
  });

  describe("the keyboard, once the control it pressed goes", () => {
    function dropSend(): void {
      useHeldComposerSendStore.getState().applyChange({
        terminalId: "t1",
        held: null,
        ended: {
          token: "token-1",
          outcome: { kind: "dropped", reason: "typed" },
          text: "held text",
        },
      });
    }

    it("goes back to the pane after Dismiss", () => {
      dropSend();
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const dismiss = screen.getByRole("button", { name: "Dismiss unsent held message" });
      dismiss.focus();
      fireEvent.click(dismiss);
      expect(screen.queryByTestId("held-composer-send-dropped")).toBeNull();
      expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput");
    });

    it("goes to the pane's home surface, the terminal when that is home", () => {
      inputs.hybridInputAutoFocus = false;
      dropSend();
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const dismiss = screen.getByRole("button", { name: "Dismiss unsent held message" });
      dismiss.focus();
      fireEvent.click(dismiss);
      expect(requestPaneFocus).toHaveBeenCalledWith("t1", "xterm");
    });

    it("is left alone by a Dismiss clicked while it was somewhere else", () => {
      dropSend();
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss unsent held message" }));
      expect(screen.queryByTestId("held-composer-send-dropped")).toBeNull();
      expect(requestPaneFocus).not.toHaveBeenCalled();
    });

    it("goes back to the pane after Withdraw", async () => {
      withdraw.mockImplementation(async () => {
        useHeldComposerSendStore.getState().applyChange({
          terminalId: "t1",
          held: null,
          ended: { token: "token-1", outcome: { kind: "withdrawn" } },
        });
        return true;
      });
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Withdraw held message" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput"));
      expect(screen.queryByTestId("held-composer-send")).toBeNull();
    });

    // Main's push lands before its answer, as it can: the row has already moved on.
    it.each([
      [
        "sending",
        () =>
          useHeldComposerSendStore
            .getState()
            .applyChange({ terminalId: "t1", held: send({ status: "sending" }) }),
      ],
      [
        "dropped",
        () =>
          useHeldComposerSendStore.getState().applyChange({
            terminalId: "t1",
            held: null,
            ended: { token: "token-1", outcome: { kind: "dropped", reason: "input-blocked" } },
          }),
      ],
      [
        "not-held",
        () =>
          useHeldComposerSendStore.getState().applyChange({
            terminalId: "t1",
            held: null,
            ended: { token: "token-1", outcome: { kind: "delivered" } },
          }),
      ],
    ] as const)("goes back to the pane after Send now answers %s", async (outcome, push) => {
      sendNow.mockImplementationOnce(async () => {
        push();
        return { outcome };
      });
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Send now" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput"));
      expect(requestPaneFocus).toHaveBeenCalledTimes(1);
    });

    it("goes back to the pane when Withdraw finds the send already on its way", async () => {
      withdraw.mockImplementationOnce(async () => {
        useHeldComposerSendStore
          .getState()
          .applyChange({ terminalId: "t1", held: send({ status: "sending" }) });
        return false;
      });
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Withdraw held message" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput"));
      expect(screen.getByTestId("held-composer-send").textContent).toContain("Sending");
    });

    it("goes back to the pane when Edit finds the send already on its way", async () => {
      withdraw.mockResolvedValue(false);
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Edit" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput"));
      expect(drafts.has(KEY)).toBe(false);
    });

    it("stays where the user took it while Send now was on its way", async () => {
      let answer!: () => void;
      sendNow.mockImplementationOnce(
        () => new Promise((resolve) => (answer = () => resolve({ outcome: "sending" })))
      );
      useHeldComposerSendStore.getState().noteHeld(send());
      render(
        <>
          <HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />
          <input aria-label="elsewhere" />
        </>
      );
      const button = screen.getByRole("button", { name: "Send now" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(sendNow).toHaveBeenCalledTimes(1));
      screen.getByRole("textbox", { name: "elsewhere" }).focus();
      await act(async () => answer());
      expect(requestPaneFocus).not.toHaveBeenCalled();
    });

    it("stays where a press elsewhere left it while Send now was on its way", async () => {
      let answer!: () => void;
      sendNow.mockImplementationOnce(
        () => new Promise((resolve) => (answer = () => resolve({ outcome: "sending" })))
      );
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Send now" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(sendNow).toHaveBeenCalledTimes(1));
      // A press on something that takes no focus: the keyboard falls to the page.
      focusEpoch.value += 1;
      button.blur();
      await act(async () => answer());
      expect(requestPaneFocus).not.toHaveBeenCalled();
    });

    it("goes back to the pane when the pressed control lost it to the page", async () => {
      let answer!: () => void;
      sendNow.mockImplementationOnce(
        () => new Promise((resolve) => (answer = () => resolve({ outcome: "sending" })))
      );
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Send now" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(sendNow).toHaveBeenCalledTimes(1));
      // Chromium takes the keyboard off a button as it is disabled.
      button.blur();
      await act(async () => answer());
      expect(requestPaneFocus).toHaveBeenCalledWith("t1", "hybridInput");
    });

    // Its controls are still there to press again: nothing is asked of the pane.
    it("asks nothing of the pane when Send now fails", async () => {
      sendNow.mockRejectedValueOnce(new Error("ipc down"));
      useHeldComposerSendStore.getState().noteHeld(send());
      render(<HeldComposerSendRow terminalId="t1" agentId="gemini" canEdit />);
      const button = screen.getByRole("button", { name: "Send now" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
      expect(screen.getByRole("button", { name: "Send now" })).toBe(button);
      expect(requestPaneFocus).not.toHaveBeenCalled();
    });
  });
});
