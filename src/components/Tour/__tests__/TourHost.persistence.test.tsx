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
// The host only needs the definition's identity and length, not the real scenes.
vi.mock("../daintreeTour", () => ({
  DAINTREE_TOUR: {
    id: "daintree",
    title: "Daintree Tour",
    chapters: Array.from({ length: 14 }, (_, i) => ({
      id: `c${i}`,
      title: `C${i}`,
      scene: () => null,
    })),
    resolveTimings: () => [],
  },
}));
vi.mock("../TourDialog", () => ({
  TourDialog: (props: TourDialogProps) => {
    dialogProps.current = props;
    return null;
  },
}));

import type { TourDefinition } from "../tourDefinition";
import { openTour, TOUR_COMPLETED_EVENT } from "../tourEvents";
import { TourHost } from "../TourHost";
import { registerTour } from "../tourRegistry";

const ACME_TOUR_ID = makePluginTourId("acme.tools", "welcome");
const acmeTour: TourDefinition = {
  id: ACME_TOUR_ID,
  title: "Acme Tour",
  chapters: [
    { id: "one", title: "One", scene: () => null },
    { id: "two", title: "Two", scene: () => null },
  ],
  resolveTimings: () => [],
};

let onboarding: {
  setTourProgress: ReturnType<typeof vi.fn>;
  setTourMuted: ReturnType<typeof vi.fn>;
};

async function openHostedTour(tourId?: string) {
  render(<TourHost />);
  act(() => {
    openTour(tourId);
  });
  await waitFor(() => expect(dialogProps.current).not.toBeNull());
  return dialogProps.current!;
}

describe("TourHost", () => {
  beforeEach(() => {
    dialogProps.current = null;
    getOnboardingStateMock.mockReset();
    onboarding = {
      setTourProgress: vi.fn().mockResolvedValue(undefined),
      setTourMuted: vi.fn().mockResolvedValue(true),
    };
    Reflect.set(window, "electron", { onboarding });
  });
  let unregister: () => void = () => {};
  afterEach(() => {
    unregister();
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
    const props = await openHostedTour();
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
    const props = await openHostedTour();
    expect(props.initialChapter).toBe(0);
  });

  it("records progress and completion against the Daintree tour id, mute globally", async () => {
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    const props = await openHostedTour();
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

  it("opens the Daintree tour when no tour is named", async () => {
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    const props = await openHostedTour();
    expect(props.tour.id).toBe(DAINTREE_TOUR_ID);
  });

  it("plays a registered tour by id, with its own progress and completion", async () => {
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: ["One", "Two"] },
      load: () => Promise.resolve(acmeTour),
    });
    getOnboardingStateMock.mockResolvedValue({
      tours: {
        [DAINTREE_TOUR_ID]: { completed: false, dismissed: false, lastChapter: 5 },
        [ACME_TOUR_ID]: { completed: false, dismissed: false, lastChapter: 1 },
      },
      tourMuted: false,
    });
    const completed = vi.fn((event: Event): unknown =>
      event instanceof CustomEvent ? event.detail : null
    );
    window.addEventListener(TOUR_COMPLETED_EVENT, completed);
    const props = await openHostedTour(ACME_TOUR_ID);
    expect(props.tour).toBe(acmeTour);
    expect(props.initialChapter).toBe(1);
    act(() => {
      props.onChapterReached(1);
      props.onCompleted();
    });
    window.removeEventListener(TOUR_COMPLETED_EVENT, completed);
    expect(onboarding.setTourProgress).toHaveBeenNthCalledWith(1, ACME_TOUR_ID, { lastChapter: 1 });
    expect(onboarding.setTourProgress).toHaveBeenNthCalledWith(2, ACME_TOUR_ID, {
      completed: true,
      lastChapter: 0,
    });
    expect(completed.mock.results[0]!.value).toEqual({ tourId: ACME_TOUR_ID });
  });

  it("resumes against the tour's own length, not the Daintree tour's", async () => {
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: ["One", "Two"] },
      load: () => Promise.resolve(acmeTour),
    });
    getOnboardingStateMock.mockResolvedValue({
      tours: { [ACME_TOUR_ID]: { completed: false, dismissed: false, lastChapter: 5 } },
      tourMuted: false,
    });
    const props = await openHostedTour(ACME_TOUR_ID);
    expect(props.initialChapter).toBe(0);
  });

  it("opens nothing for an id no tour is registered under", async () => {
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    render(<TourHost />);
    await act(async () => {
      openTour("plugin:missing/tour");
      await Promise.resolve();
    });
    expect(dialogProps.current).toBeNull();
    expect(getOnboardingStateMock).not.toHaveBeenCalled();
  });

  it("opens nothing when the tour fails to load", async () => {
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load: () => Promise.reject(new Error("load failed")),
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    render(<TourHost />);
    await act(async () => {
      openTour(ACME_TOUR_ID);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialogProps.current).toBeNull();
  });

  it("starts from the beginning when stored progress can't be read", async () => {
    getOnboardingStateMock.mockRejectedValue(new Error("no bridge"));
    const props = await openHostedTour();
    expect(props.initialChapter).toBe(0);
    expect(props.initialMuted).toBe(false);
  });

  it("opens the latest requested tour when an earlier load finishes last", async () => {
    let resolveSlow: (tour: TourDefinition) => void = () => {};
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load: () => new Promise((resolve) => (resolveSlow = resolve)),
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    render(<TourHost />);
    act(() => {
      openTour(ACME_TOUR_ID);
      openTour();
    });
    await waitFor(() => expect(dialogProps.current?.tour.id).toBe(DAINTREE_TOUR_ID));
    await act(async () => {
      resolveSlow(acmeTour);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialogProps.current!.tour.id).toBe(DAINTREE_TOUR_ID);
  });
});
