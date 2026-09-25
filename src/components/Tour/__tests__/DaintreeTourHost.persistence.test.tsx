// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAINTREE_TOUR_ID, makePluginTourId } from "@shared/utils/tourIds";
import type { TourDialogProps } from "../TourDialog";

const { getOnboardingStateMock, dialogProps } = vi.hoisted(() => ({
  getOnboardingStateMock: vi.fn(),
  dialogProps: { current: null as TourDialogProps | null },
}));
vi.mock("@/clients/onboardingClient", () => ({ getOnboardingState: getOnboardingStateMock }));
vi.mock("../TourDialog", () => ({
  TourDialog: (props: TourDialogProps) => {
    dialogProps.current = props;
    return null;
  },
}));

import { DaintreeTourHost } from "../DaintreeTourHost";
import { OPEN_DAINTREE_TOUR_EVENT } from "../tourEvents";

let onboarding: {
  setTourProgress: ReturnType<typeof vi.fn>;
  setTourMuted: ReturnType<typeof vi.fn>;
};

async function openTour() {
  render(<DaintreeTourHost />);
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_DAINTREE_TOUR_EVENT));
  });
  await waitFor(() => expect(dialogProps.current).not.toBeNull());
  return dialogProps.current!;
}

describe("DaintreeTourHost persistence", () => {
  beforeEach(() => {
    dialogProps.current = null;
    onboarding = {
      setTourProgress: vi.fn().mockResolvedValue(undefined),
      setTourMuted: vi.fn().mockResolvedValue(true),
    };
    Reflect.set(window, "electron", { onboarding });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("resumes the Daintree tour's own progress, not another tour's", async () => {
    getOnboardingStateMock.mockResolvedValue({
      tours: {
        [makePluginTourId("acme.tools", "welcome")]: {
          completed: false,
          dismissed: false,
          lastChapter: 4,
        },
        [DAINTREE_TOUR_ID]: { completed: false, dismissed: false, lastChapter: 2 },
      },
      tourMuted: true,
    });
    const props = await openTour();
    expect(props.initialChapter).toBe(2);
    expect(props.initialMuted).toBe(true);
  });

  it("starts from the beginning when only other tours have progress", async () => {
    getOnboardingStateMock.mockResolvedValue({
      tours: {
        [makePluginTourId("acme.tools", "welcome")]: {
          completed: false,
          dismissed: false,
          lastChapter: 4,
        },
      },
      tourMuted: false,
    });
    const props = await openTour();
    expect(props.initialChapter).toBe(0);
  });

  it("records progress and completion against the Daintree tour id, mute globally", async () => {
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    const props = await openTour();
    act(() => {
      props.onChapterReached(3);
      props.onCompleted();
      props.onMutedChange(true);
    });
    expect(onboarding.setTourProgress).toHaveBeenNthCalledWith(1, DAINTREE_TOUR_ID, {
      lastChapter: 3,
    });
    expect(onboarding.setTourProgress).toHaveBeenNthCalledWith(2, DAINTREE_TOUR_ID, {
      completed: true,
      lastChapter: 0,
    });
    expect(onboarding.setTourMuted).toHaveBeenCalledWith(true);
  });
});
