// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TourOnboardingState } from "@shared/types";

const { getOnboardingStateMock } = vi.hoisted(() => ({ getOnboardingStateMock: vi.fn() }));
vi.mock("@/clients/onboardingClient", () => ({ getOnboardingState: getOnboardingStateMock }));

import { DAINTREE_TOUR_COMPLETED_EVENT, OPEN_DAINTREE_TOUR_EVENT } from "../tourEvents";
import { TOUR_LAUNCHER_SESSIONS, TourLauncherButton } from "../TourLauncherButton";

const tour = (patch: Partial<TourOnboardingState>): TourOnboardingState => ({
  completed: false,
  launcherSessions: 0,
  muted: false,
  lastChapter: 0,
  ...patch,
});

let markShown: ReturnType<typeof vi.fn>;

function setup(stored: TourOnboardingState, afterMark: TourOnboardingState) {
  getOnboardingStateMock.mockResolvedValue({ tour: stored });
  markShown = vi.fn().mockResolvedValue(afterMark);
  Reflect.set(window, "electron", { onboarding: { markTourLauncherShown: markShown } });
}

describe("TourLauncherButton", () => {
  beforeEach(() => {
    getOnboardingStateMock.mockReset();
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("offers the tour through the last session of the window", async () => {
    setup(
      tour({ launcherSessions: TOUR_LAUNCHER_SESSIONS - 1 }),
      tour({ launcherSessions: TOUR_LAUNCHER_SESSIONS })
    );
    render(<TourLauncherButton />);
    const button = await screen.findByRole("button", { name: "Take the Daintree Tour" });
    const opened = vi.fn();
    window.addEventListener(OPEN_DAINTREE_TOUR_EVENT, opened);
    fireEvent.click(button);
    window.removeEventListener(OPEN_DAINTREE_TOUR_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("stops offering once the session window has passed", async () => {
    setup(
      tour({ launcherSessions: TOUR_LAUNCHER_SESSIONS }),
      tour({ launcherSessions: TOUR_LAUNCHER_SESSIONS + 1 })
    );
    render(<TourLauncherButton />);
    await waitFor(() => expect(markShown).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never counts or shows a session once the tour is finished", async () => {
    setup(tour({ completed: true }), tour({ completed: true }));
    render(<TourLauncherButton />);
    await waitFor(() => expect(getOnboardingStateMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(markShown).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("withdraws the offer as soon as the tour is finished", async () => {
    setup(tour({ launcherSessions: 0 }), tour({ launcherSessions: 1 }));
    render(<TourLauncherButton />);
    await screen.findByRole("button", { name: "Take the Daintree Tour" });
    act(() => {
      window.dispatchEvent(new CustomEvent(DAINTREE_TOUR_COMPLETED_EVENT));
    });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
