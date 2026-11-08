/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { CIStatusState, NormalizedPRState } from "@shared/types/forge";
import type { ForgeNewPRLink } from "@shared/types/ipc/forge";

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    getChecks: vi.fn(),
    getPR: vi.fn(() => Promise.resolve(null)),
    getRepoMetadata: vi.fn(() => Promise.resolve(null)),
  },
}));

import { PrStatusChip } from "../PrStatusChip";

afterEach(cleanup);

function triggerDescription(trigger: HTMLElement): string {
  const id = trigger.getAttribute("aria-describedby");
  return (id && document.getElementById(id)?.textContent) || "";
}

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
            newPRLink={null}
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

  it("names the trigger by the words it shows and describes it in full", () => {
    const { getByRole } = render(
      <PrStatusChip
        hasRemote
        worktreePath="/tmp/wt"
        newPRLink={null}
        onOpenExternal={() => undefined}
        worktreePR={{
          prNumber: 42,
          prUrl: "https://github.com/o/r/pull/42",
          prState: "open",
          prCiStatus: { state: "success", total: 1, passed: 1, failed: 0, pending: 0, rawData: {} },
          mergeIntent: { kind: "auto-merge", method: "squash", enabledAt: 1, enabledBy: "octocat" },
        }}
      />
    );
    // jsdom applies no stylesheet, so the spans join without the spaces a
    // browser puts between flex items; the order of the words is the contract.
    const trigger = getByRole("button", {
      name: /^Pull request\s*#42\s*open\s*passing\s*auto-merge\s*squash\s*show CI checks$/,
    });
    expect(triggerDescription(trigger)).toMatch(/^Pull request #42 open — CI passing — /);
  });

  it("shows a pending merge GitHub reports, whoever armed it (#13747)", () => {
    const { getByTestId } = render(
      <PrStatusChip
        hasRemote
        worktreePath="/tmp/wt"
        newPRLink={null}
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
    expect(triggerDescription(getByTestId("pr-checks-trigger"))).toMatch(/armed by octocat/);
  });

  it("flags a head that moved while armed", () => {
    const { getByTestId } = render(
      <PrStatusChip
        hasRemote
        worktreePath="/tmp/wt"
        newPRLink={null}
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
    expect(triggerDescription(getByTestId("pr-checks-trigger"))).toMatch(/without another review/);
  });

  it("drops a stale intent once the PR has merged", () => {
    const { queryByTestId } = render(
      <PrStatusChip
        hasRemote
        worktreePath="/tmp/wt"
        newPRLink={null}
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

  describe("with no pull request", () => {
    function renderNoPr(newPRLink: ForgeNewPRLink | null, hasRemote = true) {
      const onOpenExternal = vi.fn();
      const view = render(
        <PrStatusChip
          hasRemote={hasRemote}
          worktreePath="/tmp/wt"
          worktreePR={null}
          newPRLink={newPRLink}
          onOpenExternal={onOpenExternal}
        />
      );
      return { ...view, onOpenExternal };
    }

    it("opens the forge's page when the branch can have one", () => {
      const url = "https://github.com/o/r/compare/develop...topic?expand=1";
      const { getByRole, onOpenExternal } = renderNoPr({
        state: "ready",
        term: "pull-request",
        url,
      });

      fireEvent.click(getByRole("button", { name: /^No PR\s*open new pull request$/ }));

      expect(onOpenExternal).toHaveBeenCalledWith(url);
    });

    it("uses the forge's own word for it", () => {
      const { getByRole, queryByText } = renderNoPr({
        state: "ready",
        term: "merge-request",
        url: "https://gitlab.com/o/r/-/merge_requests/new",
      });

      getByRole("button", { name: /^No MR\s*open new merge request$/ });
      expect(queryByText("No PR")).toBeNull();
    });

    it("says an unpushed branch isn't pushed, and offers no link", () => {
      const { getByText, queryByRole } = renderNoPr({ state: "unpushed", term: "pull-request" });

      getByText("No PR");
      getByText("not pushed");
      expect(queryByRole("button")).toBeNull();
    });

    it("stays a static badge when there is nothing to offer", () => {
      const { getByText, queryByText, queryByRole } = renderNoPr({
        state: "unavailable",
        term: "pull-request",
      });

      getByText("No PR");
      expect(queryByText("not pushed")).toBeNull();
      expect(queryByRole("button")).toBeNull();
    });

    it("stays out of the way until the answer is in", () => {
      const { container } = renderNoPr(null);

      expect(container.textContent).toBe("");
    });

    it("shows nothing without a remote, whatever the answer", () => {
      const { container } = renderNoPr({ state: "unpushed", term: "pull-request" }, false);

      expect(container.textContent).toBe("");
    });
  });
});
