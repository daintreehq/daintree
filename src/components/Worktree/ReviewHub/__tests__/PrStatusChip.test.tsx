/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { CIStatusState, NormalizedPRState } from "@shared/types/forge";

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { getChecks: vi.fn() },
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
});
