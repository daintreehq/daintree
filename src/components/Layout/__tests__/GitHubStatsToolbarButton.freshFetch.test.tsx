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

/**
 * Corner activity chip wiring.
 *
 * The toolbar issues + PRs buttons render a small triangular chip in the
 * top-right corner when their poll-driven count goes up while the dropdown
 * is closed. The chip is purely a "fresh activity" cue — it auto-clears
 * ACTIVITY_CHIP_TTL_MS after the most recent increase, and immediately when
 * the user opens the matching dropdown. Color matches each category
 * (`bg-github-open` for issues, `bg-github-merged` for PRs); commits get no
 * chip. State is local component state and is intentionally not persisted —
 * the chip is not an unread-state indicator.
 */
describe("GitHubStatsToolbarButton corner activity chip wiring", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("declares per-category pulseAt state with a 3-minute TTL constant", () => {
    expect(source).toMatch(
      /\[issuesPulseAt,\s*setIssuesPulseAt\]\s*=\s*useState<number\s*\|\s*null>/
    );
    expect(source).toMatch(/\[prsPulseAt,\s*setPrsPulseAt\]\s*=\s*useState<number\s*\|\s*null>/);
    expect(source).toMatch(/ACTIVITY_CHIP_TTL_MS\s*=\s*3\s*\*\s*60\s*\*\s*1000/);
  });

  it("does not import the deprecated seen-anchors store or its helper", () => {
    expect(source).not.toContain("githubSeenAnchorsStore");
    expect(source).not.toContain("deriveBadgeLabel");
    expect(source).not.toContain("recordOpen");
  });

  it("sets pulseAt alongside the digit-pulse increment for issues and PRs only", () => {
    // The count-increase detector is wrapped in useEffectEvent and must drive
    // both the existing per-digit anim key and the new chip pulse timestamp
    // for the two categories that get a chip. Commits get the digit pulse
    // but no chip.
    const eventStart = source.indexOf("checkForCountIncrease = useEffectEvent");
    const closeBrace = source.indexOf("});", eventStart);
    const slice = source.slice(eventStart, closeBrace);
    expect(slice).toMatch(/setIssueAnimKey\([\s\S]{0,80}?setIssuesPulseAt\(Date\.now\(\)\)/);
    expect(slice).toMatch(/setPrAnimKey\([\s\S]{0,80}?setPrsPulseAt\(Date\.now\(\)\)/);
    expect(slice).not.toContain("setCommitsPulseAt");
  });

  it("clears pulseAt on the open transition for both onClick and imperative paths", () => {
    // The chip is dismissed the moment the user opens the matching dropdown.
    // Both the click handlers and the useImperativeHandle openIssues / openPrs
    // methods must clear pulseAt on the closed→open transition only.
    expect(source).toMatch(/willOpen\s*\)\s*setIssuesPulseAt\(null\)/);
    expect(source).toMatch(/willOpen\s*\)\s*setPrsPulseAt\(null\)/);
    expect(source).toMatch(/!issuesOpenRef\.current\)\s*setIssuesPulseAt\(null\)/);
    expect(source).toMatch(/!prsOpenRef\.current\)\s*setPrsPulseAt\(null\)/);
  });

  it("schedules an auto-clear timer per pulseAt with ACTIVITY_CHIP_TTL_MS", () => {
    // Each chip clears itself ACTIVITY_CHIP_TTL_MS after the most recent
    // increase via a useEffect that listens on the matching pulseAt and
    // schedules a setTimeout for the remaining lifetime.
    expect(source).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,400}?issuesPulseAt[\s\S]{0,400}?ACTIVITY_CHIP_TTL_MS[\s\S]{0,400}?setIssuesPulseAt\(null\)/
    );
    expect(source).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,400}?prsPulseAt[\s\S]{0,400}?ACTIVITY_CHIP_TTL_MS[\s\S]{0,400}?setPrsPulseAt\(null\)/
    );
  });

  it("derives showIssuesChip / showPrsChip with open-state and count guards", () => {
    expect(source).toMatch(
      /showIssuesChip\s*=[\s\S]{0,200}?issuesPulseAt\s*!==\s*null[\s\S]{0,200}?!issuesOpen[\s\S]{0,200}?\(issueCount\s*\?\?\s*0\)\s*>\s*0/
    );
    expect(source).toMatch(
      /showPrsChip\s*=[\s\S]{0,200}?prsPulseAt\s*!==\s*null[\s\S]{0,200}?!prsOpen[\s\S]{0,200}?\(prCount\s*\?\?\s*0\)\s*>\s*0/
    );
  });

  it("renders a top-right triangular chip with the matching github color", () => {
    // Issues chip uses bg-github-open (green); PRs chip uses bg-github-merged
    // (purple). Both are clipped to a top-right triangle and pointer-events
    // disabled so they don't intercept clicks on the button.
    const issuesAnchor = source.indexOf("<CircleDot");
    const issuesSlice = source.slice(issuesAnchor, issuesAnchor + 1200);
    expect(issuesSlice).toContain("showIssuesChip");
    expect(issuesSlice).toContain("bg-github-open");
    expect(issuesSlice).toContain("polygon(0 0, 100% 0, 100% 100%)");
    expect(issuesSlice).toContain("pointer-events-none");
    expect(issuesSlice).toContain('aria-hidden="true"');

    const prAnchor = source.indexOf("<GitPullRequest");
    const prSlice = source.slice(prAnchor, prAnchor + 1200);
    expect(prSlice).toContain("showPrsChip");
    expect(prSlice).toContain("bg-github-merged");
    expect(prSlice).toContain("polygon(0 0, 100% 0, 100% 100%)");
    expect(prSlice).toContain("pointer-events-none");
    expect(prSlice).toContain('aria-hidden="true"');
  });

  it("does not render a chip on the commits button", () => {
    const commitsAnchor = source.indexOf("<GitCommit");
    const commitsSlice = source.slice(commitsAnchor, commitsAnchor + 800);
    expect(commitsSlice).not.toContain("showCommitsChip");
    expect(commitsSlice).not.toContain("bg-github-open");
    expect(commitsSlice).not.toContain("bg-github-merged");
    expect(commitsSlice).not.toContain("clipPath");
  });

  it("folds 'new since last view' into the issues + PRs aria-labels", () => {
    expect(source).toMatch(/showIssuesChip\s*\?\s*" \(new since last view\)"\s*:\s*""/);
    expect(source).toMatch(/showPrsChip\s*\?\s*" \(new since last view\)"\s*:\s*""/);
  });

  it("clears both chip pulses on project switch alongside the count refs", () => {
    // useRepositoryStats clears lastUpdated to null on project switch. The
    // matching reset block must also drop any active chip so a chip earned
    // on the previous project doesn't linger.
    const effectStart = source.indexOf("if (statsLoading || statsError)");
    const slice = source.slice(effectStart, effectStart + 1500);
    expect(slice).toContain("setIssuesPulseAt(null)");
    expect(slice).toContain("setPrsPulseAt(null)");
  });
});
