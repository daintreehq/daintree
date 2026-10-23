import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getOnboardingStateMock } = vi.hoisted(() => ({ getOnboardingStateMock: vi.fn() }));
vi.mock("@/clients/onboardingClient", () => ({ getOnboardingState: getOnboardingStateMock }));

import { readTourStatus, tourCandidates } from "../tourStatus";
import { registerTour } from "../tourRegistry";

const TOUR_ID = "acme.tools.welcome";

describe("tourCandidates", () => {
  it("defaults to the Daintree tour and prefers a plugin's own local id", () => {
    expect(tourCandidates(undefined, "acme.tools")).toEqual(["daintree"]);
    expect(tourCandidates("welcome")).toEqual(["welcome"]);
    expect(tourCandidates("welcome", "acme.tools")).toEqual([TOUR_ID]);
  });

  it("tries the string as a qualified id only for the plugin's own tours and the Daintree tour", () => {
    expect(tourCandidates(TOUR_ID, "acme.tools")).toEqual([`acme.tools.${TOUR_ID}`, TOUR_ID]);
    expect(tourCandidates("daintree", "acme.tools")).toEqual(["acme.tools.daintree", "daintree"]);
    expect(tourCandidates("other.plugin.welcome", "acme.tools")).toEqual([
      "acme.tools.other.plugin.welcome",
    ]);
    // A plugin whose id merely shares a prefix is still someone else's.
    expect(tourCandidates("acme.toolsx.welcome", "acme.tools")).toEqual([
      "acme.tools.acme.toolsx.welcome",
    ]);
  });
});

describe("readTourStatus", () => {
  let unregister: () => void = () => {};
  beforeEach(() => {
    getOnboardingStateMock.mockReset();
  });
  afterEach(() => unregister());

  function registerVersion(version?: string) {
    unregister = registerTour({
      summary: {
        id: TOUR_ID,
        title: "Welcome",
        minutes: 1,
        chapterTitles: [],
        ...(version !== undefined ? { version } : {}),
      },
      load: () => Promise.reject(new Error("not loaded in this test")),
    });
  }

  it("reports a completion saved before versions were kept as completed", async () => {
    registerVersion();
    getOnboardingStateMock.mockResolvedValue({
      tours: { [TOUR_ID]: { completed: true, dismissed: false, lastChapter: 0 } },
    });
    expect(await readTourStatus([TOUR_ID])).toEqual({
      tourId: TOUR_ID,
      registered: true,
      contentVersion: null,
      completed: true,
      completedCurrentVersion: true,
      dismissed: false,
      lastChapterId: null,
      progressVersion: null,
      lastOutcome: null,
      lastRunId: null,
    });
  });

  it("says an older version's completion doesn't cover the current one, and drops its resume point", async () => {
    registerVersion("2");
    getOnboardingStateMock.mockResolvedValue({
      tours: {
        [TOUR_ID]: {
          completed: true,
          completedVersion: "1",
          dismissed: false,
          lastChapter: 1,
          lastChapterId: "two",
          contentVersion: "1",
          lastOutcome: "completed",
          lastRunId: "r1",
        },
      },
    });
    expect(await readTourStatus([TOUR_ID])).toMatchObject({
      contentVersion: "2",
      completed: true,
      completedCurrentVersion: false,
      lastChapterId: null,
      progressVersion: "1",
      lastOutcome: "completed",
      lastRunId: "r1",
    });
  });

  it("finds a withdrawn tour's progress under the qualified id a plugin was given", async () => {
    getOnboardingStateMock.mockResolvedValue({
      tours: {
        [TOUR_ID]: {
          completed: false,
          dismissed: false,
          lastChapter: 0,
          lastOutcome: "withdrawn",
          lastRunId: "r2",
        },
      },
    });
    expect(await readTourStatus(tourCandidates(TOUR_ID, "acme.tools"))).toMatchObject({
      tourId: TOUR_ID,
      registered: false,
      lastOutcome: "withdrawn",
      lastRunId: "r2",
    });
  });

  it("doesn't read another plugin's progress through its qualified id", async () => {
    getOnboardingStateMock.mockResolvedValue({
      tours: {
        [TOUR_ID]: {
          completed: true,
          dismissed: false,
          lastChapter: 0,
          lastOutcome: "completed",
          lastRunId: "r3",
        },
      },
    });
    expect(await readTourStatus(tourCandidates(TOUR_ID, "other.plugin"))).toMatchObject({
      tourId: `other.plugin.${TOUR_ID}`,
      registered: false,
      completed: false,
      lastOutcome: null,
      lastRunId: null,
    });
  });

  it("still reads saved progress for a tour this view hasn't registered", async () => {
    getOnboardingStateMock.mockResolvedValue({
      tours: { [TOUR_ID]: { completed: false, dismissed: true, lastChapter: 0 } },
    });
    expect(await readTourStatus([TOUR_ID, "welcome"])).toMatchObject({
      tourId: TOUR_ID,
      registered: false,
      dismissed: true,
    });
  });
});
