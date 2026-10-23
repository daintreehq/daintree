// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAINTREE_TOUR_ID, makePluginTourId } from "@shared/utils/tourIds";
import type { TourDialogProps } from "../TourDialog";

const { getOnboardingStateMock, dialogProps, notifyMock } = vi.hoisted(() => ({
  getOnboardingStateMock: vi.fn(),
  dialogProps: { current: null as TourDialogProps | null },
  notifyMock: vi.fn(),
}));
vi.mock("@/clients/onboardingClient", () => ({ getOnboardingState: getOnboardingStateMock }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
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
    return <div data-testid="tour-dialog-mock" />;
  },
}));

const screenHasDialog = () => document.querySelector("[data-testid='tour-dialog-mock']") !== null;

import type { TourDefinition } from "../tourDefinition";
import { openTour, TOUR_COMPLETED_EVENT, TOUR_OUTCOME_EVENT } from "../tourEvents";
import { requestTour, type TourStartResult } from "../tourRequests";
import { resolveOpenState, TourHost } from "../TourHost";
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
    notifyMock.mockReset();
    onboarding = {
      setTourProgress: vi.fn().mockResolvedValue(undefined),
      setTourMuted: vi.fn().mockResolvedValue(true),
    };
    Reflect.set(window, "electron", { onboarding });
  });
  let unregister: () => void = () => {};
  afterEach(() => {
    // Unmount first: a host closing under an open tour saves its outcome through the bridge.
    cleanup();
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
      lastChapterId: "c3",
      contentVersion: null,
    });
    expect(onboarding.setTourProgress).toHaveBeenNthCalledWith(2, DAINTREE_TOUR_ID, {
      completed: true,
      lastChapter: 0,
      contentVersion: null,
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
    try {
      const props = await openHostedTour(ACME_TOUR_ID);
      expect(props.tour).toBe(acmeTour);
      expect(props.initialChapter).toBe(1);
      act(() => {
        props.onChapterReached(1);
        props.onCompleted();
      });
    } finally {
      window.removeEventListener(TOUR_COMPLETED_EVENT, completed);
    }
    expect(onboarding.setTourProgress).toHaveBeenNthCalledWith(1, ACME_TOUR_ID, {
      lastChapter: 1,
      lastChapterId: "two",
      contentVersion: null,
    });
    expect(onboarding.setTourProgress).toHaveBeenNthCalledWith(2, ACME_TOUR_ID, {
      completed: true,
      lastChapter: 0,
      contentVersion: null,
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

  it("opens nothing when the tour fails to load, and can be asked again", async () => {
    const load = vi.fn<() => Promise<TourDefinition>>(() => {
      // Thrown rather than rejected: the host must still let go of the request.
      throw new Error("load failed");
    });
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load,
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    render(<TourHost />);
    await act(async () => {
      openTour(ACME_TOUR_ID);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialogProps.current).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({ type: "error" });
    expect(notifyMock.mock.calls[0]![0].message).toContain("Acme Tour");

    load.mockImplementation(() => Promise.resolve(acmeTour));
    act(() => {
      openTour(ACME_TOUR_ID);
    });
    await waitFor(() => expect(dialogProps.current?.tour).toBe(acmeTour));
  });

  it("keeps an open tour where it is when it is asked for again", async () => {
    // A fresh object per load, as a plugin's loader may well return.
    const load = vi.fn(() => Promise.resolve({ ...acmeTour }));
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load,
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    const first = await openHostedTour(ACME_TOUR_ID);
    await act(async () => {
      openTour(ACME_TOUR_ID);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(dialogProps.current!.tour).toBe(first.tour);
  });

  it("drops a tour still loading once the dialog is closed", async () => {
    const slowLoad = vi.fn();
    let resolveSlow: (tour: TourDefinition) => void = () => {};
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load: () => {
        slowLoad();
        return new Promise((resolve) => (resolveSlow = resolve));
      },
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    const daintree = await openHostedTour();
    act(() => {
      openTour(ACME_TOUR_ID);
    });
    // The load has to be under way before the close, or there's nothing to drop.
    await waitFor(() => expect(slowLoad).toHaveBeenCalled());
    act(() => {
      daintree.onClose();
    });
    await act(async () => {
      resolveSlow(acmeTour);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialogProps.current!.tour.id).toBe(DAINTREE_TOUR_ID);
    expect(screenHasDialog()).toBe(false);
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

  it("closes an open tour whose registration is withdrawn, and keeps its progress", async () => {
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load: () => Promise.resolve(acmeTour),
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    await openHostedTour(ACME_TOUR_ID);
    expect(screenHasDialog()).toBe(true);
    onboarding.setTourProgress.mockClear();

    act(() => unregister());

    expect(screenHasDialog()).toBe(false);
    // Withdrawal is not completion: only how the run ended is written on the way out.
    expect(onboarding.setTourProgress).toHaveBeenCalledTimes(1);
    expect(onboarding.setTourProgress.mock.calls[0]).toEqual([
      ACME_TOUR_ID,
      { lastOutcome: "withdrawn", lastRunId: expect.any(String) },
    ]);
  });

  it("closes an open tour replaced under the same id, as a plugin reload does", async () => {
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load: () => Promise.resolve(acmeTour),
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    await openHostedTour(ACME_TOUR_ID);

    const reloaded = { ...acmeTour, title: "Acme Tour v2" };
    act(() => {
      unregister();
      unregister = registerTour({
        summary: { id: ACME_TOUR_ID, title: "Acme Tour v2", minutes: 1, chapterTitles: [] },
        load: () => Promise.resolve(reloaded),
      });
    });
    expect(screenHasDialog()).toBe(false);

    dialogProps.current = null;
    act(() => {
      openTour(ACME_TOUR_ID);
    });
    await waitFor(() => expect(dialogProps.current?.tour).toBe(reloaded));
  });

  it("leaves another open tour alone when an unrelated tour is withdrawn", async () => {
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load: () => Promise.resolve(acmeTour),
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    await openHostedTour();

    act(() => unregister());

    expect(dialogProps.current!.tour.id).toBe(DAINTREE_TOUR_ID);
    expect(screenHasDialog()).toBe(true);
  });

  it("drops a tour still loading when its registration is withdrawn", async () => {
    let resolveSlow: (tour: TourDefinition) => void = () => {};
    const slowLoad = vi.fn(() => new Promise<TourDefinition>((resolve) => (resolveSlow = resolve)));
    unregister = registerTour({
      summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
      load: slowLoad,
    });
    getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    render(<TourHost />);
    act(() => {
      openTour(ACME_TOUR_ID);
    });
    await waitFor(() => expect(slowLoad).toHaveBeenCalled());

    act(() => unregister());
    await act(async () => {
      resolveSlow(acmeTour);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(dialogProps.current).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });
  describe("requests and outcomes", () => {
    let outcomes: { tourId: string; outcome: string; runId: string | null }[] = [];
    const onOutcome = (event: Event) => {
      if (event instanceof CustomEvent) outcomes.push(event.detail);
    };
    beforeEach(() => {
      outcomes = [];
      window.addEventListener(TOUR_OUTCOME_EVENT, onOutcome);
      getOnboardingStateMock.mockResolvedValue({ tours: {}, tourMuted: false });
    });
    afterEach(() => window.removeEventListener(TOUR_OUTCOME_EVENT, onOutcome));

    function registerAcme(tour: TourDefinition = acmeTour) {
      unregister = registerTour({
        summary: {
          id: ACME_TOUR_ID,
          title: "Acme Tour",
          minutes: 1,
          chapterTitles: [],
          ...(tour.version !== undefined ? { version: tour.version } : {}),
        },
        load: () => Promise.resolve(tour),
      });
    }

    async function request(candidates: string[], registrationTimeoutMs?: number) {
      let result: TourStartResult | undefined;
      act(() => {
        void requestTour(candidates, { registrationTimeoutMs }).then((r) => (result = r));
      });
      await waitFor(() => expect(result).toBeDefined());
      return result!;
    }

    it("reports started with the run id once the dialog is on screen, and completion once", async () => {
      registerAcme();
      render(<TourHost />);
      const result = await request([ACME_TOUR_ID]);
      expect(result).toEqual({
        status: "started",
        tourId: ACME_TOUR_ID,
        runId: expect.any(String),
      });
      expect(screenHasDialog()).toBe(true);
      // Nothing has ended yet: being asked to open is not completing.
      expect(outcomes).toEqual([]);

      const props = dialogProps.current!;
      act(() => {
        props.onCompleted();
        props.onCompleted();
        props.onClose();
        props.onClose();
      });
      expect(outcomes).toEqual([
        {
          tourId: ACME_TOUR_ID,
          outcome: "completed",
          runId: result.status === "started" ? result.runId : null,
        },
      ]);
      expect(onboarding.setTourProgress).toHaveBeenLastCalledWith(ACME_TOUR_ID, {
        lastOutcome: "completed",
        lastRunId: result.status === "started" ? result.runId : "",
      });
    });

    it("records a run closed before its end as dismissed, without touching the invitation", async () => {
      registerAcme();
      render(<TourHost />);
      await request([ACME_TOUR_ID]);
      act(() => dialogProps.current!.onClose());
      expect(outcomes.map((o) => o.outcome)).toEqual(["dismissed"]);
      for (const [, update] of onboarding.setTourProgress.mock.calls) {
        expect(update).not.toHaveProperty("dismissed");
      }
    });

    it("records the open run as superseded when another tour replaces it", async () => {
      registerAcme();
      render(<TourHost />);
      await request([ACME_TOUR_ID]);
      const next = await request([DAINTREE_TOUR_ID]);
      expect(next.status).toBe("started");
      expect(dialogProps.current!.tour.id).toBe(DAINTREE_TOUR_ID);
      expect(outcomes).toEqual([
        { tourId: ACME_TOUR_ID, outcome: "superseded", runId: expect.any(String) },
      ]);
    });

    it("answers an earlier request still loading as superseded by a later one", async () => {
      let resolveSlow: (tour: TourDefinition) => void = () => {};
      unregister = registerTour({
        summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
        load: () => new Promise((resolve) => (resolveSlow = resolve)),
      });
      render(<TourHost />);
      let first: TourStartResult | undefined;
      act(() => {
        void requestTour([ACME_TOUR_ID]).then((r) => (first = r));
      });
      const second = await request([DAINTREE_TOUR_ID]);
      await waitFor(() => expect(first).toEqual({ status: "superseded", tourId: ACME_TOUR_ID }));
      expect(second.status).toBe("started");
      resolveSlow(acmeTour);
    });

    it("joins a repeated request for the tour already playing to the same run", async () => {
      registerAcme();
      render(<TourHost />);
      const first = await request([ACME_TOUR_ID]);
      const again = await request([ACME_TOUR_ID]);
      expect(again).toEqual(first);
    });

    it("reports a tour that couldn't load as failed, and saves that outcome", async () => {
      unregister = registerTour({
        summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
        load: () => Promise.reject(new Error("import failed")),
      });
      render(<TourHost />);
      const result = await request([ACME_TOUR_ID]);
      expect(result).toMatchObject({ status: "failed", tourId: ACME_TOUR_ID });
      expect(outcomes).toEqual([{ tourId: ACME_TOUR_ID, outcome: "failed", runId: null }]);
      // An outcome never restamps the saved chapter's version, or a failed v2
      // load would let a repaired v2 resume a chapter saved under v1.
      expect(onboarding.setTourProgress).toHaveBeenCalledWith(ACME_TOUR_ID, {
        lastOutcome: "failed",
      });
    });

    it("answers a request whose tour is withdrawn while it loads as unavailable", async () => {
      unregister = registerTour({
        summary: { id: ACME_TOUR_ID, title: "Acme Tour", minutes: 1, chapterTitles: [] },
        load: () => new Promise<TourDefinition>(() => {}),
      });
      render(<TourHost />);
      let result: TourStartResult | undefined;
      act(() => {
        void requestTour([ACME_TOUR_ID]).then((r) => (result = r));
      });
      await waitFor(() => expect(getOnboardingStateMock).toHaveBeenCalled());
      act(() => unregister());
      await waitFor(() =>
        expect(result).toEqual({
          status: "unavailable",
          tourId: ACME_TOUR_ID,
          reason: "not-registered",
        })
      );
    });

    it("records an open run withdrawn by its plugin as withdrawn", async () => {
      registerAcme();
      render(<TourHost />);
      await request([ACME_TOUR_ID]);
      act(() => unregister());
      expect(outcomes.map((o) => o.outcome)).toEqual(["withdrawn"]);
    });

    it("answers unavailable when nothing registers the tour within the bound", async () => {
      render(<TourHost />);
      const result = await request(["acme.tools.missing"], 0);
      expect(result).toEqual({
        status: "unavailable",
        tourId: "acme.tools.missing",
        reason: "not-registered",
      });
      expect(screenHasDialog()).toBe(false);
    });

    it("waits for a tour registered shortly after the request", async () => {
      render(<TourHost />);
      let result: TourStartResult | undefined;
      act(() => {
        void requestTour([ACME_TOUR_ID], { registrationTimeoutMs: 1_000 }).then(
          (r) => (result = r)
        );
      });
      await act(async () => {
        await Promise.resolve();
        registerAcme();
      });
      await waitFor(() => expect(result?.status).toBe("started"));
    });

    it("answers a request still waiting for its tour as superseded once another tour opens", async () => {
      render(<TourHost />);
      let waiting: TourStartResult | undefined;
      act(() => {
        void requestTour([ACME_TOUR_ID], { registrationTimeoutMs: 1_000 }).then(
          (r) => (waiting = r)
        );
      });
      const daintree = await request([DAINTREE_TOUR_ID]);
      expect(daintree.status).toBe("started");
      await waitFor(() => expect(waiting).toEqual({ status: "superseded", tourId: ACME_TOUR_ID }));
      // Registering afterwards must not open the stale request over the newer tour.
      await act(async () => {
        registerAcme();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(dialogProps.current!.tour.id).toBe(DAINTREE_TOUR_ID);
    });

    it("records an open run as withdrawn when its view's host unmounts", async () => {
      registerAcme();
      const { unmount } = render(<TourHost />);
      await request([ACME_TOUR_ID]);
      unmount();
      expect(outcomes.map((o) => o.outcome)).toEqual(["withdrawn"]);
    });

    it("answers unavailable when no tour host is mounted", async () => {
      registerAcme();
      const result = await request([ACME_TOUR_ID]);
      expect(result).toEqual({ status: "unavailable", tourId: ACME_TOUR_ID, reason: "no-host" });
    });

    it("prefers the first candidate registered, so a plugin's own id wins", async () => {
      registerAcme();
      render(<TourHost />);
      const result = await request(["acme.tools.other", ACME_TOUR_ID]);
      expect(result).toMatchObject({ status: "started", tourId: ACME_TOUR_ID });
    });

    it("resumes a versioned tour after a reload at the saved chapter id", async () => {
      const versioned: TourDefinition = {
        ...acmeTour,
        version: "2",
        // Reordered since the progress was saved: "two" now comes first.
        chapters: [acmeTour.chapters[1]!, acmeTour.chapters[0]!],
      };
      registerAcme(versioned);
      getOnboardingStateMock.mockResolvedValue({
        tours: {
          [ACME_TOUR_ID]: {
            completed: false,
            dismissed: false,
            lastChapter: 1,
            lastChapterId: "two",
            contentVersion: "2",
          },
        },
        tourMuted: false,
      });
      const { unmount } = render(<TourHost />);
      unmount();
      const props = await openHostedTour(ACME_TOUR_ID);
      expect(props.initialChapter).toBe(0);
      act(() => props.onChapterReached(1));
      expect(onboarding.setTourProgress).toHaveBeenLastCalledWith(ACME_TOUR_ID, {
        lastChapter: 1,
        lastChapterId: "one",
        contentVersion: "2",
      });
    });
  });
});

describe("resolveOpenState", () => {
  const base = { completed: false, dismissed: false, lastChapter: 0 };
  const CHAPTERS = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}` }));
  const at = (progress: Parameters<typeof resolveOpenState>[0], version?: string) =>
    resolveOpenState(progress, false, CHAPTERS, version).initialChapter;

  it("starts a finished tour over, including one finished before versions were kept", () => {
    expect(at({ ...base, completed: true, lastChapter: 4 })).toBe(0);
    expect(at({ ...base, completed: true, lastChapter: 4, lastChapterId: "c4" })).toBe(0);
  });

  it("ignores a chapter index the tour no longer has", () => {
    expect(at({ ...base, lastChapter: CHAPTERS.length })).toBe(0);
  });

  it("resumes an index-only record by index while the tour is unversioned", () => {
    expect(at({ ...base, lastChapter: 4 })).toBe(4);
  });

  it("resumes by chapter id when the chapters are reordered", () => {
    const reordered = [{ id: "c4" }, ...CHAPTERS.filter((chapter) => chapter.id !== "c4")];
    expect(
      resolveOpenState(
        { ...base, lastChapter: 4, lastChapterId: "c4", contentVersion: "2" },
        false,
        reordered,
        "2"
      ).initialChapter
    ).toBe(0);
    expect(
      resolveOpenState(
        { ...base, lastChapter: 0, lastChapterId: "c4", contentVersion: "2" },
        false,
        [...CHAPTERS].reverse(),
        "2"
      ).initialChapter
    ).toBe(9);
  });

  it("starts over when the chapter it stopped at was removed, never falling back to the index", () => {
    expect(at({ ...base, lastChapter: 4, lastChapterId: "gone", contentVersion: "2" }, "2")).toBe(
      0
    );
  });

  it("starts over when the content version changed or a record predates versioning", () => {
    expect(at({ ...base, lastChapter: 4, lastChapterId: "c4", contentVersion: "1" }, "2")).toBe(0);
    expect(at({ ...base, lastChapter: 4 }, "2")).toBe(0);
    expect(at({ ...base, lastChapter: 4, lastChapterId: "c4", contentVersion: "2" })).toBe(0);
  });

  it("resumes a newer version's run after an older version was finished", () => {
    expect(
      at(
        {
          ...base,
          completed: true,
          completedVersion: "1",
          lastChapter: 4,
          lastChapterId: "c4",
          contentVersion: "2",
        },
        "2"
      )
    ).toBe(4);
  });
});
