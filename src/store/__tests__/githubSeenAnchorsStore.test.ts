// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  deriveBadgeLabel,
  SEEN_SUPPRESSION_TTL_MS,
  useGitHubSeenAnchorsStore,
  type GitHubSeenAnchor,
} from "../githubSeenAnchorsStore";

describe("deriveBadgeLabel", () => {
  const now = 1_700_000_000_000;
  const fresh: GitHubSeenAnchor = { count: 10, seenAt: now - 60_000 };

  it("returns null when there is no anchor", () => {
    expect(deriveBadgeLabel(undefined, 12, false, now)).toBeNull();
  });

  it("returns null while the dropdown is open", () => {
    expect(deriveBadgeLabel(fresh, 15, true, now)).toBeNull();
  });

  it("returns null when the anchor is older than 72 hours", () => {
    const stale: GitHubSeenAnchor = { count: 10, seenAt: now - SEEN_SUPPRESSION_TTL_MS - 1 };
    expect(deriveBadgeLabel(stale, 50, false, now)).toBeNull();
  });

  it("returns a label exactly at the 72-hour boundary", () => {
    const atBoundary: GitHubSeenAnchor = { count: 10, seenAt: now - SEEN_SUPPRESSION_TTL_MS };
    expect(deriveBadgeLabel(atBoundary, 12, false, now)).toBe("+2");
  });

  it("returns null when current count is null", () => {
    expect(deriveBadgeLabel(fresh, null, false, now)).toBeNull();
  });

  it("returns null when delta is zero", () => {
    expect(deriveBadgeLabel(fresh, 10, false, now)).toBeNull();
  });

  it("returns null when delta is negative", () => {
    expect(deriveBadgeLabel(fresh, 5, false, now)).toBeNull();
  });

  it("returns +1 for a delta of 1", () => {
    expect(deriveBadgeLabel(fresh, 11, false, now)).toBe("+1");
  });

  it("returns +N for typical deltas", () => {
    expect(deriveBadgeLabel(fresh, 17, false, now)).toBe("+7");
  });

  it("returns +99 at the cap edge", () => {
    expect(deriveBadgeLabel(fresh, 109, false, now)).toBe("+99");
  });

  it("returns +99+ when delta exceeds cap", () => {
    expect(deriveBadgeLabel(fresh, 110, false, now)).toBe("+99+");
    expect(deriveBadgeLabel(fresh, 5_000, false, now)).toBe("+99+");
  });

  it("anchors at zero correctly", () => {
    const zeroAnchor: GitHubSeenAnchor = { count: 0, seenAt: now - 60_000 };
    expect(deriveBadgeLabel(zeroAnchor, 0, false, now)).toBeNull();
    expect(deriveBadgeLabel(zeroAnchor, 1, false, now)).toBe("+1");
  });

  it("returns null for non-finite count or seenAt (corrupted persisted state)", () => {
    expect(deriveBadgeLabel({ count: NaN, seenAt: now - 60_000 }, 12, false, now)).toBeNull();
    expect(deriveBadgeLabel({ count: 10, seenAt: NaN }, 12, false, now)).toBeNull();
    expect(deriveBadgeLabel({ count: Infinity, seenAt: now - 60_000 }, 12, false, now)).toBeNull();
    expect(
      deriveBadgeLabel({ count: "bad" as unknown as number, seenAt: now - 60_000 }, 12, false, now)
    ).toBeNull();
  });
});

describe("useGitHubSeenAnchorsStore.recordOpen", () => {
  beforeEach(() => {
    useGitHubSeenAnchorsStore.setState({ anchors: {} });
  });

  it("records an anchor for the given project + category", () => {
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", 12);
    const anchor = useGitHubSeenAnchorsStore.getState().anchors["/proj/a"]?.issues;
    expect(anchor?.count).toBe(12);
    expect(anchor?.seenAt).toBeGreaterThan(0);
  });

  it("isolates anchors across projects", () => {
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", 12);
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/b", "issues", 99);
    const state = useGitHubSeenAnchorsStore.getState().anchors;
    expect(state["/proj/a"]?.issues?.count).toBe(12);
    expect(state["/proj/b"]?.issues?.count).toBe(99);
  });

  it("isolates anchors across categories within the same project", () => {
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", 12);
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "prs", 4);
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "commits", 30);
    const proj = useGitHubSeenAnchorsStore.getState().anchors["/proj/a"];
    expect(proj?.issues?.count).toBe(12);
    expect(proj?.prs?.count).toBe(4);
    expect(proj?.commits?.count).toBe(30);
  });

  it("clears the anchor when count is null (open before stats loaded)", () => {
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", 12);
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "prs", 4);
    expect(useGitHubSeenAnchorsStore.getState().anchors["/proj/a"]?.issues?.count).toBe(12);

    // Opening again while count is unknown clears the issues anchor only —
    // the badge will be suppressed until the next open with a known count.
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", null);
    const proj = useGitHubSeenAnchorsStore.getState().anchors["/proj/a"];
    expect(proj?.issues).toBeUndefined();
    expect(proj?.prs?.count).toBe(4);
  });

  it("recordOpen with null count is a no-op when no prior anchor exists", () => {
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", null);
    expect(useGitHubSeenAnchorsStore.getState().anchors["/proj/a"]?.issues).toBeUndefined();
  });

  it("re-recording the same category updates count and seenAt without disturbing siblings", () => {
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", 12);
    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "prs", 4);
    const firstSeenAt = useGitHubSeenAnchorsStore.getState().anchors["/proj/a"]?.issues?.seenAt;
    expect(firstSeenAt).toBeDefined();

    // Wait a hair so seenAt advances past the first call's timestamp.
    const start = Date.now();
    while (Date.now() === start) {
      // tight loop until the millisecond ticks over
    }

    useGitHubSeenAnchorsStore.getState().recordOpen("/proj/a", "issues", 25);
    const proj = useGitHubSeenAnchorsStore.getState().anchors["/proj/a"];
    expect(proj?.issues?.count).toBe(25);
    expect(proj?.issues?.seenAt).toBeGreaterThan(firstSeenAt!);
    expect(proj?.prs?.count).toBe(4);
  });
});
