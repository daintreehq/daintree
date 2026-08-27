// @vitest-environment jsdom
/**
 * ImportEnvDialog — the rules the two steps have to keep obeying (#11973).
 *
 * These assert invariants rather than values, because the values are exactly
 * what a design pass changes: the labels, the tiers and the copy are all free
 * to move, but "the preview must reflect the selected policy" and "both sides
 * of a comparison must be named in text" are not. Each one was written against
 * a defect the captured pixels actually showed, and each was mutation-checked
 * by reintroducing that defect.
 *
 * `EnvVarEditor.test.tsx` covers the merge semantics, the dynamic labels and
 * the Back-preserves-the-paste contract against a mocked AppDialog. This file
 * deliberately renders the real one, because focus choreography, the footer
 * hint slot and the scroll region only exist there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, within, waitFor, cleanup } from "@testing-library/react";
import { ImportEnvDialog } from "../ImportEnvDialog";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const EXISTING = {
  ANTHROPIC_API_KEY: "sk-ant-old",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  NODE_ENV: "development",
};

function renderDialog(env: Record<string, string> = EXISTING) {
  const onImport = vi.fn<(merged: Record<string, string>) => void>();
  const onClose = vi.fn();
  render(<ImportEnvDialog isOpen onClose={onClose} env={env} onImport={onImport} />);
  return { onImport, onClose };
}

function paste(text: string) {
  fireEvent.change(screen.getByTestId("import-env-textarea"), { target: { value: text } });
}

const primary = () =>
  screen
    .getByTestId("import-env-dialog")
    .querySelector<HTMLButtonElement>('[data-confirm-role="confirm"]')!;

/** Paste two colliding keys and advance to the conflict step. */
function goToConflicts() {
  paste("ANTHROPIC_API_KEY=sk-ant-new\nNODE_ENV=production");
  fireEvent.click(primary());
  return screen.getByTestId("import-env-conflict-list");
}

describe("ImportEnvDialog", () => {
  beforeEach(() => {
    cleanup();
  });

  describe("the conflict preview", () => {
    /**
     * The defect: the list rendered every existing value struck through with
     * the incoming value in accent, identically under both policies — so with
     * "Keep existing" selected the preview claimed the opposite of what the
     * import would do. Asserting only that the two renders DIFFER keeps this
     * honest without pinning any particular treatment.
     */
    it("renders the rows differently under each merge policy", () => {
      renderDialog();
      goToConflicts();
      // Scoped to the scrolling rows, NOT the whole list: the caption strip
      // restates the policy, so asserting on the container would pass on that
      // alone while the rows carried on contradicting it.
      const rows = screen.getByTestId("import-env-conflict-scroller");
      const keep = rows.innerHTML;

      fireEvent.click(screen.getByTestId("import-env-mode-overwrite"));
      expect(rows.innerHTML).not.toBe(keep);

      fireEvent.click(screen.getByTestId("import-env-mode-keep"));
      expect(rows.innerHTML).toBe(keep);
    });

    /** The policy is also stated in words, for anyone who cannot see the weight. */
    it("states the resulting policy in text, and restates it when the policy changes", () => {
      renderDialog();
      const list = goToConflicts();
      const strip = list.firstElementChild!;
      const keep = strip.textContent?.trim();
      expect(keep).toBeTruthy();

      fireEvent.click(screen.getByTestId("import-env-mode-overwrite"));
      expect(strip.textContent?.trim()).not.toBe(keep);
    });

    /**
     * WCAG 1.4.1 / 1.3.1: which value is the existing one and which is the
     * incoming one cannot rest on colour, order, or a strikethrough — every row
     * has to say so in text. Checks that each row names both of its sides
     * without pinning what it calls them.
     */
    it("names both sides of every row in text", () => {
      renderDialog();
      const list = goToConflicts();
      const rows = within(list).getAllByRole("listitem");
      expect(rows.length).toBe(2);

      for (const row of rows) {
        const labels = Array.from(row.querySelectorAll("dt")).map((t) => t.textContent?.trim());
        expect(labels).toHaveLength(2);
        expect(labels.every((l) => !!l && l.length > 0)).toBe(true);
        // The two sides must be told apart from each other, not just labelled.
        expect(new Set(labels).size).toBe(2);
        expect(row.querySelectorAll("dd")).toHaveLength(2);
      }
    });

    /** Strikethrough is not announced, and does not survive forced-colors. */
    it("does not carry the comparison on a strikethrough", () => {
      renderDialog();
      expect(goToConflicts().innerHTML).not.toMatch(/line-through/);
    });

    /**
     * The caption pairs a label with a count pill, and the gap between them is
     * margin — which name computation does not see. Asserting the count reads
     * as its own word keeps the heading from announcing "Conflicts2"; the
     * label itself is free to change, so nothing here pins the wording.
     */
    it("separates the caption's count from its label in the announced name", () => {
      renderDialog();
      const list = goToConflicts();
      expect(within(list).getByRole("heading", { name: /\s\d+$/ })).toBeTruthy();
    });

    /**
     * The list is capped, so some of it is off-screen whenever there are more
     * conflicts than fit — which makes reaching the rest by keyboard part of
     * the destructive preview, not a nicety.
     */
    it("exposes the capped list as a reachable, named scroll region", () => {
      renderDialog();
      goToConflicts();
      const scroller = screen.getByTestId("import-env-conflict-scroller");
      expect(scroller.tabIndex).toBeGreaterThanOrEqual(0);
      expect(scroller.getAttribute("aria-label")?.trim()).toBeTruthy();
    });
  });

  describe("the primary action", () => {
    /**
     * The defect: with four parse errors the disabled button still read
     * "Import 1 variable", which describes a partial import that never happens.
     * A count on a button that cannot be pressed is a promise, so there must
     * not be one.
     */
    it("never advertises a count while it is disabled", () => {
      renderDialog();
      paste("GOOD=fine\nthis line has no equals sign");
      expect(primary().disabled).toBe(true);
      expect(primary().textContent).not.toMatch(/\d/);
    });

    it("advertises a count once it can actually be pressed", () => {
      renderDialog();
      paste("BRAND_NEW=1\nALSO_NEW=2");
      expect(primary().disabled).toBe(false);
      expect(primary().textContent).toMatch(/\d/);
    });

    /** A dead button that explains nothing is a dead end. */
    it("says why it is disabled whenever the user has pasted something", () => {
      renderDialog();
      paste("this line has no equals sign");
      expect(primary().disabled).toBe(true);
      expect(screen.getByTestId("app-dialog-hint").textContent?.trim()).toBeTruthy();
    });

    it("stays quiet about it before anything is pasted", () => {
      renderDialog();
      expect(primary().disabled).toBe(true);
      expect(screen.queryByTestId("app-dialog-hint")).toBeNull();
    });
  });

  describe("parse problems", () => {
    /**
     * WCAG 3.3.1: the error region has to be reachable FROM the field, not just
     * visible near it. Resolves the association through the DOM so no id string
     * is duplicated into the test.
     */
    it("associates the error region with the field it describes", () => {
      renderDialog();
      paste("this line has no equals sign");
      const textarea = screen.getByTestId("import-env-textarea");
      expect(textarea.getAttribute("aria-invalid")).toBe("true");

      const describedBy = textarea.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)).toBe(screen.getByTestId("import-env-errors"));
    });

    it("drops the association again once the paste parses", () => {
      renderDialog();
      paste("this line has no equals sign");
      paste("FINE=yes");
      const textarea = screen.getByTestId("import-env-textarea");
      expect(textarea.getAttribute("aria-invalid")).toBeNull();
      expect(textarea.getAttribute("aria-describedby")).toBeNull();
    });

    /**
     * The defect: the detection summary was gated on a clean parse, so a paste
     * containing both a bad line and a duplicated key reported the bad line and
     * said nothing about the value it had already discarded.
     */
    it("still reports discarded duplicate keys when the paste also fails to parse", () => {
      renderDialog();
      paste("DUPED=one\nDUPED=two\nthis line has no equals sign");
      expect(screen.getByTestId("import-env-summary").textContent).toMatch(/duplicate key/i);
    });
  });

  describe("stage orientation", () => {
    it("names the current stage, and renames it on advancing", () => {
      renderDialog();
      const heading = screen.getByTestId("import-env-step-heading");
      const pasteStage = heading.textContent?.trim();
      expect(pasteStage).toBeTruthy();

      goToConflicts();
      const conflictStage = screen.getByTestId("import-env-step-heading").textContent?.trim();
      expect(conflictStage).toBeTruthy();
      expect(conflictStage).not.toBe(pasteStage);
    });

    /** The dialog exists to be pasted into, so the caret starts there. */
    it("opens with focus in the paste field", async () => {
      renderDialog();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("import-env-textarea"))
      );
    });

    /**
     * APG dialog pattern: a step change must move focus deliberately rather
     * than stranding it on the footer button whose label just changed. Forward
     * announces the new stage; Back returns to the field the user came back to
     * edit.
     */
    it("moves focus to the new stage, and back to the paste field on Back", async () => {
      renderDialog();
      goToConflicts();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("import-env-step-heading"))
      );

      const back = screen
        .getByTestId("import-env-dialog")
        .querySelector<HTMLButtonElement>('[data-confirm-role="cancel"]')!;
      fireEvent.click(back);
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("import-env-textarea"))
      );
    });
  });
});
