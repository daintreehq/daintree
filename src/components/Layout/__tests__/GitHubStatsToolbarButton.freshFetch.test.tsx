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
 * "+N since opened" badge wiring (issue #6530).
 *
 * Each of the three toolbar counts (issues, PRs, commits) carries a small
 * de-emphasized adornment showing the gross delta since the user last opened
 * that specific dropdown. The anchor is captured synchronously at click intent
 * (not poll completion) and stored per project + per category in a persisted
 * Zustand store. Imperative open methods must also anchor on the open
 * transition. Badge styling must use `text-muted-foreground` (no accent).
 */
describe("GitHubStatsToolbarButton +N badge wiring", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("imports the seen-anchors store and pure deriveBadgeLabel helper", () => {
    expect(source).toMatch(/from\s+"@\/store\/githubSeenAnchorsStore"/);
    expect(source).toContain("useGitHubSeenAnchorsStore");
    expect(source).toContain("deriveBadgeLabel");
  });

  it("derives a delta label for each of the three categories", () => {
    expect(source).toMatch(/issuesDeltaLabel\s*=\s*deriveBadgeLabel\(\s*issuesAnchor/);
    expect(source).toMatch(/prsDeltaLabel\s*=\s*deriveBadgeLabel\(\s*prsAnchor/);
    expect(source).toMatch(/commitsDeltaLabel\s*=\s*deriveBadgeLabel\(\s*commitsAnchor/);
  });

  it("calls recordOpen synchronously inside each willOpen branch", () => {
    // Issue, PR, and commit click handlers each anchor before any async
    // refresh fires. recordOpen is called unconditionally on the open
    // transition; a null count clears any stale anchor for that category.
    const issuesCalls = source.match(
      /recordOpen\(\s*currentProject\.path,\s*"issues"\s*,\s*issueCount\s*\)/g
    );
    const prsCalls = source.match(
      /recordOpen\(\s*currentProject\.path,\s*"prs"\s*,\s*prCount\s*\)/g
    );
    const commitsCalls = source.match(
      /recordOpen\(\s*currentProject\.path,\s*"commits"\s*,\s*commitCount\s*\)/g
    );
    // Two call sites per category — once in onClick, once in useImperativeHandle.
    expect(issuesCalls?.length).toBe(2);
    expect(prsCalls?.length).toBe(2);
    expect(commitsCalls?.length).toBe(2);
  });

  it("does not gate recordOpen on a non-null count (null clears the anchor)", () => {
    // Earlier drafts gated `recordOpen` on `issueCount != null` etc., which
    // left a stale anchor when the user opened before the first stats fetch
    // completed. The store now treats `null` as a clear-anchor signal, so the
    // call sites must NOT include the count-not-null guard.
    expect(source).not.toMatch(/willOpen\s*&&\s*issueCount\s*!=\s*null/);
    expect(source).not.toMatch(/willOpen\s*&&\s*prCount\s*!=\s*null/);
    expect(source).not.toMatch(/willOpen\s*&&\s*commitCount\s*!=\s*null/);
  });

  it("guards imperative anchor recording on the closed→open transition only", () => {
    // Anchor on the call itself, not the import — `useImperativeHandle,` also
    // appears in the React import block at the top of the file.
    const handleStart = source.indexOf("useImperativeHandle(");
    expect(handleStart).toBeGreaterThan(0);
    const slice = source.slice(handleStart, handleStart + 2200);
    // openIssues / openPrs / openCommits each guard on the *Ref.current being
    // false (i.e., currently closed) before recording an anchor — toggling to
    // close must not re-record.
    expect(slice).toMatch(/!issuesOpenRef\.current/);
    expect(slice).toMatch(/!prsOpenRef\.current/);
    expect(slice).toMatch(/!commitsOpenRef\.current/);
  });

  it("renders a muted +N badge for each category (no accent color)", () => {
    // Three rendered badges, each conditional on the matching delta label.
    const issuesBadge = source.match(/issuesDeltaLabel\s*\?\s*\(\s*<span/);
    const prsBadge = source.match(/prsDeltaLabel\s*\?\s*\(\s*<span/);
    const commitsBadge = source.match(/commitsDeltaLabel\s*\?\s*\(\s*<span/);
    expect(issuesBadge).not.toBeNull();
    expect(prsBadge).not.toBeNull();
    expect(commitsBadge).not.toBeNull();

    // Each badge span uses text-muted-foreground (codebase de-emphasis idiom),
    // not text-accent-primary or any accent token. Window is generous because
    // each block spans ~300 chars including aria attribute and inner content.
    const badgeBlocks = source.match(/DeltaLabel\s*\?\s*\([\s\S]{0,500}?<\/span>/g);
    expect(badgeBlocks).not.toBeNull();
    expect(badgeBlocks?.length).toBe(3);
    for (const block of badgeBlocks ?? []) {
      expect(block).toContain("text-muted-foreground");
      expect(block).not.toContain("text-accent");
      expect(block).not.toContain("accent-primary");
      // Child <span> aria-label inside a button with explicit aria-label is
      // ignored by ARIA — the delta is announced via the button's aria-label
      // instead. Badge spans must use aria-hidden so screen readers don't
      // double-announce the visual digits.
      expect(block).toContain('aria-hidden="true"');
      expect(block).not.toContain("aria-label");
    }
  });

  it("folds the delta label into each button's aria-label for screen readers", () => {
    // The visual badge has aria-hidden, so the delta must reach screen
    // readers via the button's accessible name. Each of the three button
    // aria-label expressions must reference its matching delta label.
    expect(source).toMatch(
      /issuesDeltaLabel\s*\?\s*` \(\$\{issuesDeltaLabel\} since last opened\)`/
    );
    expect(source).toMatch(/prsDeltaLabel\s*\?\s*` \(\$\{prsDeltaLabel\} since last opened\)`/);
    expect(source).toMatch(
      /commitsDeltaLabel\s*\?\s*` \(\$\{commitsDeltaLabel\} since last opened\)`/
    );
  });

  it("places each badge between the count digit and the FreshnessGlyph", () => {
    // For each category, source order in the button must be:
    //   <span ... tabular-nums>{count}</span>
    //   {deltaLabel ? <span ...muted...> : null}
    //   <FreshnessGlyph ...>
    // The badge-render anchor is `<category>DeltaLabel ? (` — distinct from
    // the aria-label form `<category>DeltaLabel ? \`...\`` which also
    // appears earlier in the button props.

    const issuesSpan = source.indexOf("key={issueAnimKey}");
    const issuesBadge = source.indexOf("issuesDeltaLabel ? (", issuesSpan);
    const issuesGlyph = source.indexOf("<FreshnessGlyph", issuesSpan);
    expect(issuesSpan).toBeGreaterThan(0);
    expect(issuesBadge).toBeGreaterThan(issuesSpan);
    expect(issuesGlyph).toBeGreaterThan(issuesBadge);

    const prsSpan = source.indexOf("key={prAnimKey}");
    const prsBadge = source.indexOf("prsDeltaLabel ? (", prsSpan);
    const prsGlyph = source.indexOf("<FreshnessGlyph", prsSpan);
    expect(prsSpan).toBeGreaterThan(0);
    expect(prsBadge).toBeGreaterThan(prsSpan);
    expect(prsGlyph).toBeGreaterThan(prsBadge);

    const commitsSpan = source.indexOf("key={commitAnimKey}");
    const commitsBadge = source.indexOf("commitsDeltaLabel ? (", commitsSpan);
    const commitsGlyph = source.indexOf("<FreshnessGlyph", commitsSpan);
    expect(commitsSpan).toBeGreaterThan(0);
    expect(commitsBadge).toBeGreaterThan(commitsSpan);
    expect(commitsGlyph).toBeGreaterThan(commitsBadge);
  });

  it("registers the seen-anchors store under a unique storage key", async () => {
    const storePath = path.resolve(__dirname, "../../../store/githubSeenAnchorsStore.ts");
    const storeSource = await fs.readFile(storePath, "utf-8");
    expect(storeSource).toContain('name: "daintree-github-seen-anchors"');
    expect(storeSource).toContain("registerPersistedStore");
    expect(storeSource).toMatch(/SEEN_SUPPRESSION_TTL_MS\s*=\s*72\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});
