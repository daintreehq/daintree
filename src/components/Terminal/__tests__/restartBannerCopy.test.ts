import { describe, it, expect } from "vitest";
import { RESTART_BANNER_COPY } from "../restartBannerCopy";
import type { SessionLostReason } from "@shared/types/panel";

describe("RESTART_BANNER_COPY", () => {
  it("renders the auto-restarting title with a Unicode ellipsis", () => {
    expect(RESTART_BANNER_COPY["auto-restarting"].title).toBe("Auto-restarting…");
  });

  it("renders the restarting title with a Unicode ellipsis", () => {
    expect(RESTART_BANNER_COPY["restarting"].title).toBe("Restarting…");
  });

  it("interpolates exitCode into the exit-error title", () => {
    expect(RESTART_BANNER_COPY["exit-error"]({ exitCode: 1 }).title).toBe(
      "Session exited with code 1"
    );
    expect(RESTART_BANNER_COPY["exit-error"]({ exitCode: 137 }).title).toBe(
      "Session exited with code 137"
    );
  });

  // issue #9802 / #12182 — the session-lost copy must satisfy the CLAUDE.md
  // microcopy constraints (neutral, non-accusatory; title is a period-free
  // noun phrase) for every reason the signal can carry.
  describe("session-resume-unavailable copy", () => {
    const REASONS: SessionLostReason[] = [
      "no-resume-command",
      "no-resume-path",
      "sibling-owns-session-id",
      "sibling-owns-resume-latest-slot",
    ];

    it.each(REASONS)("provides a non-empty title and description for %s", (reason) => {
      const copy = RESTART_BANNER_COPY["session-resume-unavailable"]({ reason });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
    });

    it.each(REASONS)("keeps the title a period-free noun phrase for %s", (reason) => {
      const copy = RESTART_BANNER_COPY["session-resume-unavailable"]({ reason });
      expect(copy.title.endsWith(".")).toBe(false);
    });

    it.each(REASONS)("avoids accusatory or blame-assigning phrasing for %s", (reason) => {
      const copy = RESTART_BANNER_COPY["session-resume-unavailable"]({ reason });
      const text = `${copy.title} ${copy.description}`.toLowerCase();
      expect(text).not.toMatch(/expired|you lost|your fault|agent closed|killed/);
    });

    // issue #11589 — the bulk control keeps a short visible label and carries
    // the full scope in its accessible name. Reason-independent, so one
    // representative reason is enough.
    it("keeps the bulk label period-free and shorter than its accessible name", () => {
      const copy = RESTART_BANNER_COPY["session-resume-unavailable"]({
        reason: "no-resume-command",
      });
      expect(copy.dismissAllLabel.endsWith(".")).toBe(false);
      expect(copy.dismissAllAriaLabel.endsWith(".")).toBe(false);
      expect(copy.dismissAllAriaLabel.length).toBeGreaterThan(copy.dismissAllLabel.length);
    });

    it("keeps the bulk label in sentence case", () => {
      const copy = RESTART_BANNER_COPY["session-resume-unavailable"]({
        reason: "no-resume-command",
      });
      const [firstWord = "", ...restWords] = copy.dismissAllLabel.split(" ");
      expect(firstWord).toMatch(/^[A-Z]/);
      expect(restWords.every((word) => /^[a-z]/.test(word))).toBe(true);
    });

    // issue #12182 — the reasons don't all collapse to identical copy: a
    // sibling pane already holding the conversation must read differently
    // from there being nothing to resume, and the two sibling causes must
    // read differently from each other.
    it("gives sibling-attributed reasons distinct copy from the others", () => {
      const nothingToResume = RESTART_BANNER_COPY["session-resume-unavailable"]({
        reason: "no-resume-command",
      });
      const siblingId = RESTART_BANNER_COPY["session-resume-unavailable"]({
        reason: "sibling-owns-session-id",
      });
      const siblingSlot = RESTART_BANNER_COPY["session-resume-unavailable"]({
        reason: "sibling-owns-resume-latest-slot",
      });
      expect(siblingId.title).not.toBe(nothingToResume.title);
      expect(siblingSlot.title).not.toBe(nothingToResume.title);
      expect(siblingId.title).not.toBe(siblingSlot.title);
    });

    it("shares copy between the two 'nothing to resume' reasons", () => {
      const commandFailed = RESTART_BANNER_COPY["session-resume-unavailable"]({
        reason: "no-resume-command",
      });
      const noPath = RESTART_BANNER_COPY["session-resume-unavailable"]({
        reason: "no-resume-path",
      });
      expect(commandFailed).toEqual(noPath);
    });
  });
});
