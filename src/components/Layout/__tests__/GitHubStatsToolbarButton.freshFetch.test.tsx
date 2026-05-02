import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

/**
 * GitHubStatsToolbarButton — onFreshFetch wiring (issue #6390).
 *
 * When `GitHubResourceList` lands fresh first-page data on a SWR revalidation,
 * it calls the `onFreshFetch` callback. The toolbar wires this to
 * `refreshStats()` so the dropdown's just-updated count converges into the
 * badge in the same user interaction (no waiting for the 30s poll).
 *
 * These are source-code assertions rather than render tests because the
 * toolbar's eager dynamic-import effect resolves on a microtask, and rendering
 * the full toolbar in jsdom triggers `EnvironmentTeardownError`s when
 * `import()` resolutions race the test-runner shutdown. Static checks of the
 * wiring are sufficient — `onFreshFetch` itself is exercised end-to-end by
 * `GitHubResourceList.swr.test.tsx` and `useRepositoryStats.test.tsx`.
 */
const TOOLBAR_PATH = path.resolve(__dirname, "../GitHubStatsToolbarButton.tsx");

describe("GitHubStatsToolbarButton onFreshFetch wiring", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("declares a stable handleListFreshFetch callback that calls refreshStats()", () => {
    // The handler must memoize against `refreshStats` so the dropdown's
    // `fetchData` callback identity stays stable across renders.
    expect(source).toMatch(/const\s+handleListFreshFetch\s*=\s*useCallback/);
    const handlerStart = source.indexOf("const handleListFreshFetch");
    const handlerSlice = source.slice(handlerStart, handlerStart + 400);
    expect(handlerSlice).toContain("refreshStats()");
    // Must NOT pass `force: true` — the main-process `repoStatsCache` was
    // just updated by the dropdown's `updateRepoStatsCount` write, so a
    // forced refresh would bypass that hot cache and trigger a redundant
    // GitHub network call.
    expect(handlerSlice).not.toMatch(/refreshStats\s*\(\s*\{\s*force/);
    // The handler must list `refreshStats` in its useCallback deps.
    expect(handlerSlice).toMatch(/\[\s*refreshStats\s*\]/);
  });

  it("passes onFreshFetch={handleListFreshFetch} to all four ResourceList renders", () => {
    // Eager-loaded ResourceListComponent appears once for issues and once for
    // PRs, and the Suspense LazyGitHubResourceList appears once for each as
    // well — four total prop sites.
    const matches = source.match(/onFreshFetch=\{handleListFreshFetch\}/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(4);
  });

  it("wires onFreshFetch in both the issue and PR dropdowns", () => {
    // Split the file at the PR button anchor so we can verify each block
    // contains its own onFreshFetch wiring (not just one block with two).
    const prAnchor = source.indexOf("ref={prsButtonRef}");
    expect(prAnchor).toBeGreaterThan(0);
    const issuesBlock = source.slice(0, prAnchor);
    const prsBlock = source.slice(prAnchor);
    expect(issuesBlock).toContain("onFreshFetch={handleListFreshFetch}");
    expect(prsBlock).toContain("onFreshFetch={handleListFreshFetch}");
  });
});

/**
 * Digit pulse on rising count (issues #6529 + #6536).
 *
 * When the 30s GitHub stats poll returns a count higher than the previous
 * value, the matching digit briefly scales via the shared `animate-badge-bump`
 * keyframe. Suppressed when the matching dropdown is open or `document.hidden`
 * is true. The pulse is unified across all three counts (issues, PRs, commits)
 * after #6536 swapped the bespoke per-domain color decay for the standard
 * scale pulse — the freshness tier handles staleness messaging now.
 */
describe("GitHubStatsToolbarButton digit pulse", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("imports useEffectEvent for stale-closure-safe suppression checks", () => {
    expect(source).toMatch(/import\s*\{[^}]*useEffectEvent[^}]*\}\s*from\s*"react"/);
  });

  it("declares per-digit anim counters and per-count refs", () => {
    expect(source).toMatch(/\[issueAnimKey,\s*setIssueAnimKey\]\s*=\s*useState\(0\)/);
    expect(source).toMatch(/\[prAnimKey,\s*setPrAnimKey\]\s*=\s*useState\(0\)/);
    expect(source).toMatch(/\[commitAnimKey,\s*setCommitAnimKey\]\s*=\s*useState\(0\)/);
    expect(source).toMatch(/issueCountRef\s*=\s*useRef</);
    expect(source).toMatch(/prCountRef\s*=\s*useRef</);
    expect(source).toMatch(/commitCountRef\s*=\s*useRef</);
  });

  it("uses useEffectEvent for the count-increase check", () => {
    expect(source).toMatch(/checkForCountIncrease\s*=\s*useEffectEvent/);
  });

  it("reads document.hidden and all three open-state values inside the check", () => {
    const eventStart = source.indexOf("checkForCountIncrease = useEffectEvent");
    expect(eventStart).toBeGreaterThan(0);
    const closeBrace = source.indexOf("});", eventStart);
    expect(closeBrace).toBeGreaterThan(eventStart);
    const slice = source.slice(eventStart, closeBrace);
    expect(slice).toContain("document.hidden");
    expect(slice).toContain("issuesOpen");
    expect(slice).toContain("prsOpen");
    expect(slice).toContain("commitsOpen");
  });

  it("only pulses on a strict positive delta, never on first mount", () => {
    const eventStart = source.indexOf("checkForCountIncrease = useEffectEvent");
    const closeBrace = source.indexOf("});", eventStart);
    const slice = source.slice(eventStart, closeBrace);
    // Strict greater-than guard — new value must exceed previous.
    expect(slice).toMatch(/issueCount\s*>\s*issueCountRef\.current/);
    expect(slice).toMatch(/prCount\s*>\s*prCountRef\.current/);
    expect(slice).toMatch(/commitCount\s*>\s*commitCountRef\.current/);
    // Initial-mount sentinel — `=== undefined` branch silently seeds the ref.
    expect(slice).toContain("issueCountRef.current === undefined");
    expect(slice).toContain("prCountRef.current === undefined");
    expect(slice).toContain("commitCountRef.current === undefined");
  });

  it("applies key and conditional badge-bump class to the issue digit span", () => {
    // Anchor on the CircleDot (issues icon) and check the next span.
    const issuesAnchor = source.indexOf("<CircleDot");
    expect(issuesAnchor).toBeGreaterThan(0);
    const slice = source.slice(issuesAnchor, issuesAnchor + 600);
    expect(slice).toContain("key={issueAnimKey}");
    expect(slice).toContain('"animate-badge-bump"');
    expect(slice).toMatch(/issueAnimKey\s*>\s*0/);
  });

  it("applies key and conditional badge-bump class to the PR digit span", () => {
    const prAnchor = source.indexOf("<GitPullRequest");
    expect(prAnchor).toBeGreaterThan(0);
    const slice = source.slice(prAnchor, prAnchor + 600);
    expect(slice).toContain("key={prAnimKey}");
    expect(slice).toContain('"animate-badge-bump"');
    expect(slice).toMatch(/prAnimKey\s*>\s*0/);
  });

  it("applies key and conditional badge-bump class to the commit digit span", () => {
    const commitAnchor = source.indexOf("<GitCommit");
    expect(commitAnchor).toBeGreaterThan(0);
    const slice = source.slice(commitAnchor, commitAnchor + 600);
    expect(slice).toContain("key={commitAnimKey}");
    expect(slice).toContain('"animate-badge-bump"');
    expect(slice).toMatch(/commitAnimKey\s*>\s*0/);
  });

  it("re-seeds the count refs to undefined when lastUpdated transitions to null (project switch)", () => {
    // Regression guard for spurious cross-project pulses.
    // useRepositoryStats resets lastUpdated to null on project switch, and
    // without re-seeding the refs the next first poll would compare new
    // counts against the previous project's stale counts.
    const effectStart = source.indexOf("if (statsLoading || statsError)");
    expect(effectStart).toBeGreaterThan(0);
    const slice = source.slice(effectStart, effectStart + 1500);
    expect(slice).toMatch(/lastUpdated\s*==\s*null/);
    expect(slice).toMatch(/issueCountRef\.current\s*=\s*undefined/);
    expect(slice).toMatch(/prCountRef\.current\s*=\s*undefined/);
    expect(slice).toMatch(/commitCountRef\.current\s*=\s*undefined/);
    expect(slice).toMatch(/prevLastUpdatedRef\.current\s*=\s*null/);
  });
});
