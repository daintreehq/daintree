// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TourOnboardingState } from "@shared/types";
import { DAINTREE_TOUR_ID, makePluginTourId } from "@shared/utils/tourIds";

const { getOnboardingStateMock } = vi.hoisted(() => ({ getOnboardingStateMock: vi.fn() }));
vi.mock("@/clients/onboardingClient", () => ({ getOnboardingState: getOnboardingStateMock }));

import { TOUR_CHAPTERS } from "../tourChapters";
import { DAINTREE_TOUR_COMPLETED_EVENT, OPEN_DAINTREE_TOUR_EVENT } from "../tourEvents";
import { inviteStateFor, TourInviteCard, TourWelcomeLink } from "../TourInviteCard";

const tour = (patch: Partial<TourOnboardingState> = {}): TourOnboardingState => ({
  completed: false,
  dismissed: false,
  lastChapter: 0,
  ...patch,
});

const stored = (
  daintree: TourOnboardingState,
  others: Record<string, TourOnboardingState> = {}
) => ({
  tours: { ...others, [DAINTREE_TOUR_ID]: daintree },
  tourMuted: false,
});

let dismissInvite: ReturnType<typeof vi.fn>;

function setup(daintree: TourOnboardingState, others: Record<string, TourOnboardingState> = {}) {
  getOnboardingStateMock.mockResolvedValue(stored(daintree, others));
  dismissInvite = vi.fn().mockResolvedValue({ ...daintree, dismissed: true });
  Reflect.set(window, "electron", { onboarding: { dismissTourInvite: dismissInvite } });
}

describe("inviteStateFor", () => {
  it("withdraws the offer once the tour is finished or turned down", () => {
    expect(inviteStateFor(tour({ completed: true })).kind).toBe("hidden");
    expect(inviteStateFor(tour({ dismissed: true })).kind).toBe("hidden");
  });

  it("offers to resume an unfinished tour at the chapter it stopped on", () => {
    expect(inviteStateFor(tour({ lastChapter: 4 }))).toEqual({ kind: "resume", chapter: 4 });
    expect(inviteStateFor(tour({ lastChapter: 0 })).kind).toBe("invite");
  });
});

describe("TourInviteCard", () => {
  beforeEach(() => {
    getOnboardingStateMock.mockReset();
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
    vi.useRealTimers();
  });

  it("invites until acted on, and starts the tour", async () => {
    setup(tour());
    render(<TourInviteCard />);
    const start = await screen.findByRole("button", { name: "Start tour" });
    const opened = vi.fn();
    window.addEventListener(OPEN_DAINTREE_TOUR_EVENT, opened);
    fireEvent.click(start);
    window.removeEventListener(OPEN_DAINTREE_TOUR_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("names the chapter an unfinished tour resumes at", async () => {
    setup(tour({ lastChapter: 3 }));
    render(<TourInviteCard />);
    await screen.findByRole("button", { name: "Resume tour" });
    expect(screen.getByTestId("tour-invite-card").textContent).toContain(TOUR_CHAPTERS[3]!.title);
  });

  it("dismisses permanently and says where the tour lives, then goes", async () => {
    setup(tour());
    render(<TourInviteCard />);
    const notNow = await screen.findByRole("button", { name: "Not now" });
    vi.useFakeTimers();
    fireEvent.click(notNow);
    expect(dismissInvite).toHaveBeenCalledTimes(1);
    expect(dismissInvite).toHaveBeenCalledWith(DAINTREE_TOUR_ID);
    expect(screen.getByRole("status").textContent).toContain("Help › Daintree Tour");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("withdraws as soon as the tour is finished", async () => {
    setup(tour());
    render(<TourInviteCard />);
    await screen.findByRole("button", { name: "Start tour" });
    act(() => {
      window.dispatchEvent(new CustomEvent(DAINTREE_TOUR_COMPLETED_EVENT));
    });
    expect(screen.queryByTestId("tour-invite-card")).toBeNull();
  });

  it("withdraws when the tour was finished in another project view", async () => {
    setup(tour());
    render(<TourInviteCard />);
    await screen.findByRole("button", { name: "Start tour" });
    getOnboardingStateMock.mockResolvedValue(stored(tour({ completed: true })));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.queryByTestId("tour-invite-card")).toBeNull());
  });
});

describe("TourInviteCard with other tours", () => {
  beforeEach(() => {
    getOnboardingStateMock.mockReset();
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("keeps inviting to the Daintree tour when a plugin tour is finished or turned down", async () => {
    setup(tour(), {
      [makePluginTourId("acme.tools", "welcome")]: tour({ completed: true, lastChapter: 3 }),
      [makePluginTourId("other.plugin", "welcome")]: tour({ dismissed: true }),
    });
    render(<TourInviteCard />);
    expect(await screen.findByRole("button", { name: "Start tour" })).toBeTruthy();
  });

  it("invites to the Daintree tour when no progress has been stored for it", async () => {
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    Reflect.set(window, "electron", { onboarding: { dismissTourInvite: vi.fn() } });
    render(<TourInviteCard />);
    expect(await screen.findByRole("button", { name: "Start tour" })).toBeTruthy();
  });
});

describe("TourWelcomeLink", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("stays quiet until agent setup has been answered", async () => {
    setup(tour());
    const { rerender } = render(<TourWelcomeLink enabled={false} />);
    await waitFor(() => expect(getOnboardingStateMock).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<TourWelcomeLink enabled />);
    expect(await screen.findByRole("button", { name: /Take the \d+-minute tour/ })).toBeTruthy();
  });
});
