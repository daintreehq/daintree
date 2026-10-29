/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { CIStatusState, NormalizedPRState } from "@shared/types/forge";

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    getChecks: vi.fn(),
    getPR: vi.fn(() => Promise.resolve(null)),
    getRepoMetadata: vi.fn(() => Promise.resolve(null)),
  },
}));

import { PrStatusChip } from "../PrStatusChip";

afterEach(cleanup);

const PR_STATES: NormalizedPRState[] = ["open", "merged", "closed", "declined"];
const CI_STATES: Array<CIStatusState | undefined> = [
  "success",
  "failure",
  "pending",
  "neutral",
  undefined,
];

/** Elements that paint characters of their own, rather than only a glyph. */
function textBearers(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter((el) =>
    Array.from(el.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && /[\p{L}\p{N}]/u.test(node.textContent ?? "")
    )
  );
}

describe("PrStatusChip", () => {
  it("keeps state colour on the glyphs and never on the small text beside them", () => {
    for (const prState of PR_STATES) {
      for (const ci of CI_STATES) {
        const { container, unmount } = render(
          <PrStatusChip
            hasRemote
            worktreePath="/tmp/wt"
            onOpenExternal={() => undefined}
            worktreePR={{
              prNumber: 42,
              prUrl: "https://github.com/o/r/pull/42",
              prState,
              prCiStatus: ci
                ? { state: ci, total: 1, passed: 1, failed: 0, pending: 0, rawData: {} }
                : undefined,
            }}
          />
        );
        const bearers = textBearers(container);
        expect(bearers.length).toBeGreaterThan(0);
        for (const el of bearers) {
          expect(el.className, `${prState}/${ci ?? "none"}: "${el.textContent}"`).not.toMatch(
            /\btext-(status|pr)-/
          );
        }
        unmount();
      }
    }
  });

  it("shows a pending merge GitHub reports, whoever armed it (#13747)", () => {
    const { getByTestId } = render(
      <PrStatusChip
        hasRemote
        worktreePath="/tmp/wt"
        onOpenExternal={() => undefined}
        worktreePR={{
          prNumber: 42,
          prUrl: "https://github.com/o/r/pull/42",
          prState: "open",
          mergeIntent: { kind: "auto-merge", method: "squash", enabledAt: 1, enabledBy: "octocat" },
        }}
      />
    );
    // The method is its own chip segment, behind the chip's separator.
    expect(getByTestId("pr-merge-intent").textContent).toBe("auto-merge");
    expect(getByTestId("pr-merge-intent-method").textContent).toBe("squash");
    expect(getByTestId("pr-checks-trigger").getAttribute("aria-label")).toMatch(/armed by octocat/);
  });

  it("flags a head that moved while armed", () => {
    const { getByTestId } = render(
      <PrStatusChip
        hasRemote
        worktreePath="/tmp/wt"
        onOpenExternal={() => undefined}
        worktreePR={{
          prNumber: 42,
          prUrl: "https://github.com/o/r/pull/42",
          prState: "open",
          mergeIntent: { kind: "queued", position: null },
          headMovedWhileArmed: true,
        }}
      />
    );
    expect(getByTestId("pr-merge-intent").textContent).toBe("queued");
    expect(getByTestId("pr-checks-trigger").getAttribute("aria-label")).toMatch(
      /without another review/
    );
  });

  it("drops a stale intent once the PR has merged", () => {
    const { queryByTestId } = render(
      <PrStatusChip
        hasRemote
        worktreePath="/tmp/wt"
        onOpenExternal={() => undefined}
        worktreePR={{
          prNumber: 42,
          prUrl: "https://github.com/o/r/pull/42",
          prState: "merged",
          mergeIntent: { kind: "queued", position: 1 },
        }}
      />
    );
    expect(queryByTestId("pr-merge-intent")).toBeNull();
  });
});
