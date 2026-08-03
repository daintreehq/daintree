import { describe, it, expect } from "vitest";
import { RESTART_BANNER_COPY } from "../restartBannerCopy";

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

  // issue #9802 — the session-lost copy must satisfy the CLAUDE.md microcopy
  // constraints (neutral, non-accusatory; title is a period-free noun phrase).
  describe("session-resume-unavailable copy", () => {
    const copy = RESTART_BANNER_COPY["session-resume-unavailable"];

    it("provides a non-empty title and description", () => {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
    });

    it("keeps the title a period-free noun phrase", () => {
      expect(copy.title.endsWith(".")).toBe(false);
    });

    it("avoids accusatory or blame-assigning phrasing", () => {
      const text = `${copy.title} ${copy.description}`.toLowerCase();
      expect(text).not.toMatch(/expired|you lost|your fault|agent closed|killed/);
    });

    // issue #11589 — the bulk control keeps a short visible label and carries
    // the full scope in its accessible name.
    it("keeps the bulk label period-free and shorter than its accessible name", () => {
      expect(copy.dismissAllLabel.endsWith(".")).toBe(false);
      expect(copy.dismissAllAriaLabel.endsWith(".")).toBe(false);
      expect(copy.dismissAllAriaLabel.length).toBeGreaterThan(copy.dismissAllLabel.length);
    });

    it("keeps the bulk label in sentence case", () => {
      const [firstWord = "", ...restWords] = copy.dismissAllLabel.split(" ");
      expect(firstWord).toMatch(/^[A-Z]/);
      expect(restWords.every((word) => /^[a-z]/.test(word))).toBe(true);
    });
  });
});
