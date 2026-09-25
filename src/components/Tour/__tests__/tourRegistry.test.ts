import { describe, expect, it, vi } from "vitest";
import { DAINTREE_TOUR_ID } from "@shared/utils/tourIds";
import type { TourRegistration } from "../tourDefinition";
import { TOUR_CHAPTER_TITLES, TOUR_MINUTES } from "../tourSummary.generated";
import { getTour, registerTour, subscribeTours } from "../tourRegistry";

const registration = (id: string): TourRegistration => ({
  summary: { id, title: "Acme Tour", minutes: 2, chapterTitles: ["One"] },
  load: vi.fn(() => Promise.reject(new Error("not under test"))),
});

describe("tourRegistry", () => {
  it("registers the Daintree tour like any other, summary first", () => {
    const daintree = getTour(DAINTREE_TOUR_ID)!;
    expect(daintree.summary).toEqual({
      id: DAINTREE_TOUR_ID,
      title: "Daintree Tour",
      minutes: TOUR_MINUTES,
      chapterTitles: TOUR_CHAPTER_TITLES,
    });
  });

  it("hands out a summary without loading the tour", () => {
    const acme = registration("plugin:acme.tools/welcome");
    const unregister = registerTour(acme);
    expect(getTour("plugin:acme.tools/welcome")?.summary.title).toBe("Acme Tour");
    expect(acme.load).not.toHaveBeenCalled();
    unregister();
  });

  it("knows nothing of an unregistered id", () => {
    expect(getTour("plugin:missing/tour")).toBeUndefined();
  });

  it("refuses a second tour under the same id, and cleanup withdraws only its own", () => {
    const first = registration("plugin:acme.tools/dup");
    const unregister = registerTour(first);
    expect(() => registerTour(registration("plugin:acme.tools/dup"))).toThrow(/already registered/);
    unregister();
    expect(getTour("plugin:acme.tools/dup")).toBeUndefined();

    const second = registration("plugin:acme.tools/dup");
    const unregisterSecond = registerTour(second);
    unregister();
    expect(getTour("plugin:acme.tools/dup")).toBe(second);
    unregisterSecond();
  });

  it("loads the full Daintree definition only on request", async () => {
    const tour = await getTour(DAINTREE_TOUR_ID)!.load();
    expect(tour.id).toBe(DAINTREE_TOUR_ID);
    expect(tour.chapters.map((chapter) => chapter.title)).toEqual(TOUR_CHAPTER_TITLES);
    expect(tour.chapters.every((chapter) => typeof chapter.scene === "function")).toBe(true);
    expect(tour.resolveTimings("mac")).toHaveLength(tour.chapters.length);
  });

  it("tells subscribers when a tour arrives and when it is withdrawn", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeTours((id) => seen.push(`${id}:${getTour(id) ? "in" : "out"}`));
    const unregister = registerTour(registration("acme.tools.watch"));
    unregister();
    // A second cleanup withdraws nothing, so it says nothing.
    unregister();
    unsubscribe();
    registerTour(registration("acme.tools.unwatched"))();
    expect(seen).toEqual(["acme.tools.watch:in", "acme.tools.watch:out"]);
  });
});
