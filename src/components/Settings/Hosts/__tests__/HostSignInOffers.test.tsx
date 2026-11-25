// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyHostEvent } from "@shared/types/ipc/canopyHost";

const releaseSignIn = vi.hoisted(() => vi.fn(async (_consumer: string) => undefined));
vi.mock("@/clients/canopyHostClient", () => ({ canopyHostClient: { releaseSignIn } }));
const dialogFails = vi.hoisted(() => ({ value: false }));
// The dialog itself is covered on its own; what it is handed is what matters here.
vi.mock("../HostSignInOfferDialog", () => ({
  default: ({
    offer,
    onClose,
  }: {
    offer: { hostId: string; hostName: string; agentId: string; consumer: string };
    onClose: () => void;
  }) => {
    if (dialogFails.value) throw new Error("chunk gone");
    return (
      <div
        data-testid="offer-dialog"
        data-consumer={offer.consumer}
        data-host={`${offer.hostId}/${offer.hostName}`}
        data-agent={offer.agentId}
      >
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  },
}));

import { HostSignInOffers } from "../HostSignInOffers";
import { holdSignInDialog } from "../signInDialogHold";

let emit: (event: CanopyHostEvent) => void = () => {};
let subscribed = 0;

function offer(consumer: string, expiresAt = Date.now() + 30_000): CanopyHostEvent {
  return {
    kind: "sign-in-offer",
    hostId: "studio",
    hostName: "Studio",
    agentId: "codex",
    consumer,
    terminal: { terminalId: "daintree-sign-in-1", spawnedAt: 1 },
    expiresAt,
  };
}

async function push(event: CanopyHostEvent) {
  await act(async () => {
    emit(event);
    await Promise.resolve();
  });
}

describe("HostSignInOffers (#18197)", () => {
  beforeEach(() => {
    dialogFails.value = false;
    releaseSignIn.mockClear();
    subscribed = 0;
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        canopyHost: {
          onEvent: (callback: (event: CanopyHostEvent) => void) => {
            emit = callback;
            subscribed++;
            return () => {
              subscribed--;
            };
          },
        },
      },
    });
  });
  afterEach(() => {
    emit = () => {};
  });

  it("opens an offered sign-in in the CLI's dialog, over whatever is open, and stops hearing on unmount", async () => {
    const { unmount } = render(<HostSignInOffers />);
    await push(offer("offer-1"));
    const dialog = await screen.findByTestId("offer-dialog");
    expect(dialog.getAttribute("data-consumer")).toBe("offer-1");
    expect(dialog.getAttribute("data-host")).toBe("studio/Studio");
    expect(dialog.getAttribute("data-agent")).toBe("codex");
    expect(releaseSignIn).not.toHaveBeenCalled();
    unmount();
    expect(subscribed).toBe(0);
  });

  it("opens nothing for one that already ended, or for any other push", async () => {
    render(<HostSignInOffers />);
    await push(offer("late", Date.now() - 1));
    await push({ kind: "resync", hostId: "studio" });
    expect(screen.queryByTestId("offer-dialog")).toBeNull();
    // Main already let the late one go.
    expect(releaseSignIn).not.toHaveBeenCalled();
  });

  it("refuses, and lets go, one that meets a sign-in dialog open here or one already offered", async () => {
    render(<HostSignInOffers />);
    const letGo = holdSignInDialog();
    await push(offer("over-the-person"));
    expect(screen.queryByTestId("offer-dialog")).toBeNull();
    expect(releaseSignIn.mock.calls).toEqual([["over-the-person"]]);
    letGo();

    await push(offer("first"));
    await screen.findByTestId("offer-dialog");
    await push(offer("second"));
    expect(screen.getByTestId("offer-dialog").getAttribute("data-consumer")).toBe("first");
    expect(releaseSignIn.mock.calls).toEqual([["over-the-person"], ["second"]]);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("offer-dialog")).toBeNull();
    await push(offer("third"));
    expect((await screen.findByTestId("offer-dialog")).getAttribute("data-consumer")).toBe("third");
  });

  it("ends the sign-in, not the app, when its dialog can't load, and takes the next offer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<HostSignInOffers />);
    dialogFails.value = true;
    await push(offer("broken"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId("offer-dialog")).toBeNull();
    expect(releaseSignIn.mock.calls).toEqual([["broken"]]);

    dialogFails.value = false;
    await push(offer("next"));
    expect((await screen.findByTestId("offer-dialog")).getAttribute("data-consumer")).toBe("next");
  });
});
