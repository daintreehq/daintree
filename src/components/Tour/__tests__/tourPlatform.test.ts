import { afterEach, describe, expect, it, vi } from "vitest";
import { TOUR_CHAPTERS } from "../tourChapters";
import { playableChapters } from "../tourPlatform";
import { resolveChapterTiming } from "../tourTiming";

describe("playableChapters", () => {
  it("skips Hosts on Windows only, keeping the order of the rest", () => {
    const ids = (platform: "darwin" | "linux" | "win32") =>
      playableChapters(TOUR_CHAPTERS, platform).map((chapter) => chapter.id);
    expect(ids("darwin")).toEqual(TOUR_CHAPTERS.map((chapter) => chapter.id));
    expect(ids("linux")).toEqual(ids("darwin"));
    expect(ids("win32")).toEqual(ids("darwin").filter((id) => id !== "hosts"));
  });
});

describe("the Daintree tour on Windows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadOn(platform: string, userAgent = "") {
    vi.resetModules();
    vi.stubGlobal("navigator", { platform, userAgent });
    const { DAINTREE_TOUR } = await import("../daintreeTour");
    const { DAINTREE_TOUR_SUMMARY } = await import("../daintreeTourSummary");
    return { tour: DAINTREE_TOUR, summary: DAINTREE_TOUR_SUMMARY };
  }

  // Filtering the scenes but not the timings would play Hosts' audio under Canopy's scene.
  it("plays each scene with its own chapter's timing, from Pilot straight to Canopy", async () => {
    const { tour, summary } = await loadOn("Win32");
    const ids = tour.chapters.map((chapter) => chapter.id);
    expect(ids).not.toContain("hosts");
    expect(ids.indexOf("canopy")).toBe(ids.indexOf("pilot") + 1);
    expect(summary.chapterIds).toEqual(ids);
    expect(summary.chapterTitles).toEqual(tour.chapters.map((chapter) => chapter.title));

    const timings = tour.resolveTimings("pc");
    expect(timings).toHaveLength(ids.length);
    ids.forEach((id, i) => {
      const chapter = TOUR_CHAPTERS.find((c) => c.id === id)!;
      expect(timings[i], id).toEqual(resolveChapterTiming(chapter, "pc"));
    });
  });

  it("keeps Hosts on Linux, which shares the PC keyboard", async () => {
    const { tour } = await loadOn("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    expect(tour.chapters.map((chapter) => chapter.id)).toContain("hosts");
  });

  // A position saved on a Mac is the chapter's id; on Windows the same chapter sits one earlier.
  it("offers to resume a saved chapter at its place in the Windows cut, and never Hosts", async () => {
    await loadOn("Win32");
    const { inviteStateFor } = await import("../TourInviteCard");
    const { DAINTREE_TOUR_VERSION } = await import("../daintreeTourSummary");
    const saved = (id: string) => ({
      completed: false,
      dismissed: false,
      lastChapter: TOUR_CHAPTERS.findIndex((chapter) => chapter.id === id),
      lastChapterId: id,
      contentVersion: DAINTREE_TOUR_VERSION,
    });
    const allIndex = TOUR_CHAPTERS.findIndex((chapter) => chapter.id === "canopy");
    expect(inviteStateFor(saved("canopy"))).toEqual({ kind: "resume", chapter: allIndex - 1 });
    expect(inviteStateFor(saved("hosts")).kind).toBe("invite");
  });
});
