// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignInShownAnswer } from "@shared/types/ipc/canopyHost";

const client = vi.hoisted(() => ({
  startSignIn: vi.fn(async () => ({ terminalId: "daintree-sign-in-own", spawnedAt: 2 })),
  releaseSignIn: vi.fn(async (_consumer: string) => undefined),
  signInShown: vi.fn(async (_consumer: string): Promise<SignInShownAnswer> => "shown"),
}));
vi.mock("@/clients/canopyHostClient", () => ({
  canopyHostClient: {
    ...client,
    signInStep: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
  },
}));
// The live pane is xterm; its stream's transitions are what this dialog reads.
vi.mock("@/components/Canopy/CanopyTerminal", () => ({
  CanopyTerminal: ({
    runId,
    autoFocus,
    onStreamChange,
  }: {
    runId: string;
    autoFocus?: boolean;
    onStreamChange?: (state: {
      watchId: number | null;
      ended: boolean;
      secretPrompt: boolean;
    }) => void;
  }) => (
    <div
      data-testid="sign-in-pane"
      data-run-id={runId}
      data-auto-focus={String(autoFocus === true)}
    >
      <button
        type="button"
        data-testid="pane-live"
        onClick={() => onStreamChange?.({ watchId: 3, ended: false, secretPrompt: false })}
      />
      <button
        type="button"
        data-testid="pane-lost"
        onClick={() => onStreamChange?.({ watchId: null, ended: false, secretPrompt: false })}
      />
    </div>
  ),
}));

import { HostAgentSignInDialog } from "../HostAgentSignInDialog";
import { signInDialogOpen } from "../signInDialogHold";

const OFFERED = {
  consumer: "offer-1",
  terminal: { terminalId: "daintree-sign-in-9", spawnedAt: 5 },
};

let visibility: DocumentVisibilityState = "visible";

const settledWith = vi.fn();

function dialog(offered: typeof OFFERED | null = OFFERED, onClose = () => {}) {
  return (
    <HostAgentSignInDialog
      hostId="studio"
      hostName="Studio"
      agentId="claude"
      agentName="Claude"
      {...(offered ? { offered, onOfferSettled: settledWith } : {})}
      onClose={onClose}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function becomeVisible() {
  visibility = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
}

describe("HostAgentSignInDialog on a sign-in an assistant started (#18197)", () => {
  beforeEach(async () => {
    // A dialog the last test left lets its adopted sign-in go a task later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.startSignIn.mockClear();
    client.releaseSignIn.mockClear();
    client.signInShown.mockReset();
    client.signInShown.mockResolvedValue("shown");
    settledWith.mockClear();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
  });
  afterEach(() => {
    visibility = "visible";
  });

  it("shows the terminal Main started, starts none, and leaves the keyboard where it was", async () => {
    render(dialog());
    await settle();
    expect(screen.getByTestId("host-agent-sign-in-dialog").textContent).toContain(
      "Sign in to Claude on Studio"
    );
    const pane = screen.getByTestId("sign-in-pane");
    expect(pane.getAttribute("data-run-id")).toBe("daintree-sign-in-9");
    expect(pane.getAttribute("data-auto-focus")).toBe("false");
    expect(client.startSignIn).not.toHaveBeenCalled();
  });

  it("tells Main once its stream is live, and only then", async () => {
    render(dialog());
    await settle();
    expect(client.signInShown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pane-live"));
    await settle();
    fireEvent.click(screen.getByTestId("pane-live"));
    await becomeVisible();
    expect(client.signInShown.mock.calls).toEqual([["offer-1"]]);
    expect(settledWith.mock.calls).toEqual([["shown"]]);
  });

  it("asks again after an answer it was waiting on when the view came back meanwhile", async () => {
    let answer: (value: SignInShownAnswer) => void = () => {};
    client.signInShown.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    render(dialog());
    await settle();
    fireEvent.click(screen.getByTestId("pane-live"));
    await becomeVisible();
    expect(client.signInShown).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer("not_shown");
      await Promise.resolve();
    });
    await settle();
    expect(client.signInShown).toHaveBeenCalledTimes(2);
    expect(settledWith.mock.calls).toEqual([["shown"]]);
  });

  it("asks again shortly while Main can't take it, until it does", async () => {
    vi.useFakeTimers();
    try {
      client.signInShown.mockResolvedValueOnce("not_shown");
      render(dialog());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTestId("pane-live"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(client.signInShown).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(client.signInShown).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(client.signInShown).toHaveBeenCalledTimes(2);
      expect(settledWith.mock.calls).toEqual([["shown"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so again once shown when Main couldn't take it, and stops once nothing waits", async () => {
    client.signInShown.mockResolvedValueOnce("not_shown");
    client.signInShown.mockResolvedValueOnce("gone");
    render(dialog());
    await settle();
    fireEvent.click(screen.getByTestId("pane-live"));
    await settle();
    expect(client.signInShown).toHaveBeenCalledTimes(1);
    await becomeVisible();
    expect(client.signInShown).toHaveBeenCalledTimes(2);
    await becomeVisible();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(client.signInShown).toHaveBeenCalledTimes(2);
    expect(settledWith.mock.calls).toEqual([["gone"]]);
  });

  it("asks again when the window takes focus", async () => {
    client.signInShown.mockResolvedValueOnce("not_shown");
    render(dialog());
    await settle();
    fireEvent.click(screen.getByTestId("pane-live"));
    await settle();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(client.signInShown).toHaveBeenCalledTimes(2);
  });

  it("says so again when Main makes this cached view active again, and stops hearing on close", async () => {
    const revealed = new Set<() => void>();
    const warm = new Set<() => void>();
    const listen = (set: Set<() => void>) => (callback: () => void) => {
      set.add(callback);
      return () => set.delete(callback);
    };
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { app: { onViewRevealed: listen(revealed), onViewWarmActivated: listen(warm) } },
    });
    client.signInShown.mockResolvedValueOnce("not_shown");
    client.signInShown.mockResolvedValueOnce("not_shown");
    const { unmount } = render(dialog());
    await settle();
    fireEvent.click(screen.getByTestId("pane-live"));
    await settle();
    expect(client.signInShown).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const callback of warm) callback();
      await Promise.resolve();
    });
    expect(client.signInShown).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const callback of revealed) callback();
      await Promise.resolve();
    });
    expect(client.signInShown).toHaveBeenCalledTimes(3);
    unmount();
    expect(revealed.size + warm.size).toBe(0);
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
  });

  it("waits while this view is hidden, and while its stream isn't live", async () => {
    render(dialog());
    await settle();
    visibility = "hidden";
    fireEvent.click(screen.getByTestId("pane-live"));
    await settle();
    expect(client.signInShown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pane-lost"));
    await becomeVisible();
    expect(client.signInShown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pane-live"));
    await settle();
    expect(client.signInShown.mock.calls).toEqual([["offer-1"]]);
  });

  it("tells Main nothing for the person's own sign-in, which takes the keyboard", async () => {
    render(dialog(null));
    await settle();
    expect(client.startSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-auto-focus")).toBe("true");
    fireEvent.click(screen.getByTestId("pane-live"));
    await settle();
    expect(client.signInShown).not.toHaveBeenCalled();
  });

  it("lets the adopted sign-in go when it closes, and holds off another while open", async () => {
    const { unmount } = render(dialog());
    await settle();
    expect(signInDialogOpen()).toBe(true);
    unmount();
    expect(signInDialogOpen()).toBe(false);
    await settle();
    expect(client.releaseSignIn.mock.calls).toEqual([["offer-1"]]);
  });

  it("keeps the adopted sign-in through StrictMode's replayed mount", async () => {
    render(<StrictMode>{dialog()}</StrictMode>);
    await settle();
    await settle();
    expect(client.releaseSignIn).not.toHaveBeenCalled();
    expect(client.startSignIn).not.toHaveBeenCalled();
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-run-id")).toBe(
      "daintree-sign-in-9"
    );
  });
});
