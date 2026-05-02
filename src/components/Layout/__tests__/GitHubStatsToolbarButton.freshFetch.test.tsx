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
 * Digit flash on rising count (issue #6529).
 *
 * When the 30s GitHub stats poll returns a count higher than the previous
 * value, the matching digit briefly renders in its domain hue and decays
 * back to the default text color. Suppressed when the matching dropdown
 * is open or `document.hidden` is true. Commits never flash — no domain
 * hue exists for them.
 */
describe("GitHubStatsToolbarButton digit flash", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("imports useEffectEvent for stale-closure-safe suppression checks", () => {
    expect(source).toMatch(/import\s*\{[^}]*useEffectEvent[^}]*\}\s*from\s*"react"/);
  });

  it("declares per-digit flash counters and a prevStatsRef", () => {
    expect(source).toMatch(/\[issueFlashKey,\s*setIssueFlashKey\]\s*=\s*useState\(0\)/);
    expect(source).toMatch(/\[prFlashKey,\s*setPrFlashKey\]\s*=\s*useState\(0\)/);
    expect(source).toMatch(/prevStatsRef\s*=\s*useRef</);
  });

  it("uses useEffectEvent for the count-increase check", () => {
    expect(source).toMatch(/checkForCountIncrease\s*=\s*useEffectEvent/);
  });

  it("reads document.hidden and both open-state values inside the check", () => {
    const eventStart = source.indexOf("checkForCountIncrease = useEffectEvent");
    expect(eventStart).toBeGreaterThan(0);
    const closeBrace = source.indexOf("});", eventStart);
    expect(closeBrace).toBeGreaterThan(eventStart);
    const slice = source.slice(eventStart, closeBrace);
    expect(slice).toContain("document.hidden");
    expect(slice).toContain("issuesOpen");
    expect(slice).toContain("prsOpen");
  });

  it("only flashes on a strict positive delta, not on first-load (prev null)", () => {
    const eventStart = source.indexOf("checkForCountIncrease = useEffectEvent");
    const closeBrace = source.indexOf("});", eventStart);
    const slice = source.slice(eventStart, closeBrace);
    // Strict greater-than guard — new value must exceed previous
    expect(slice).toMatch(/next\.issueCount\s*>\s*prev\.issueCount/);
    expect(slice).toMatch(/next\.prCount\s*>\s*prev\.prCount/);
    // Null guards on prev counts so first-load null doesn't trigger flash
    expect(slice).toMatch(/prev\.issueCount\s*!=\s*null/);
    expect(slice).toMatch(/prev\.prCount\s*!=\s*null/);
  });

  it("always updates prevStatsRef regardless of suppression", () => {
    const eventStart = source.indexOf("checkForCountIncrease = useEffectEvent");
    const closeBrace = source.indexOf("});", eventStart);
    const slice = source.slice(eventStart, closeBrace);
    // The write to prevStatsRef must be the last thing in the callback,
    // OUTSIDE the suppression guard, so a hidden-tab catch-up doesn't
    // replay every accumulated delta when the tab refocuses.
    const writeIndex = slice.lastIndexOf("prevStatsRef.current =");
    const lastSuppressedClose = slice.lastIndexOf("setPrFlashKey");
    expect(writeIndex).toBeGreaterThan(lastSuppressedClose);
  });

  it("applies key and conditional flash class to the issue digit span", () => {
    // Anchor on the CircleDot (issues icon) and check the next span.
    const issuesAnchor = source.indexOf("<CircleDot");
    expect(issuesAnchor).toBeGreaterThan(0);
    const slice = source.slice(issuesAnchor, issuesAnchor + 600);
    expect(slice).toContain("key={issueFlashKey}");
    expect(slice).toContain('"github-stat-count-flash-issues"');
    expect(slice).toMatch(/issueFlashKey\s*>\s*0/);
  });

  it("applies key and conditional flash class to the PR digit span", () => {
    const prAnchor = source.indexOf("<GitPullRequest");
    expect(prAnchor).toBeGreaterThan(0);
    const slice = source.slice(prAnchor, prAnchor + 600);
    expect(slice).toContain("key={prFlashKey}");
    expect(slice).toContain('"github-stat-count-flash-prs"');
    expect(slice).toMatch(/prFlashKey\s*>\s*0/);
  });

  it("does NOT flash the commit digit (no domain hue exists for commits)", () => {
    const commitAnchor = source.indexOf("<GitCommit");
    expect(commitAnchor).toBeGreaterThan(0);
    const slice = source.slice(commitAnchor, commitAnchor + 600);
    expect(slice).not.toContain("github-stat-count-flash");
    expect(slice).not.toMatch(/key=\{[a-zA-Z]*FlashKey\}/);
  });

  it("clears prevStatsRef when lastUpdated transitions to null (project switch)", () => {
    // Regression guard for spurious cross-project flashes.
    // useRepositoryStats resets lastUpdated to null on project switch, and
    // without clearing prevStatsRef the next first poll would compare new
    // counts against the previous project's stale counts.
    const effectStart = source.indexOf("if (statsLoading || statsError)");
    expect(effectStart).toBeGreaterThan(0);
    const slice = source.slice(effectStart, effectStart + 1500);
    expect(slice).toMatch(/lastUpdated\s*==\s*null/);
    expect(slice).toMatch(/prevStatsRef\.current\s*=\s*null/);
    expect(slice).toMatch(/prevLastUpdatedRef\.current\s*=\s*null/);
  });

  it("does not add transition-colors to the flashing spans (would fight @keyframes)", () => {
    // Past lesson #4738: any transition-* on the flashing element competes
    // with the @keyframes color animation and produces visible jitter.
    const issuesAnchor = source.indexOf("<CircleDot");
    const issuesSlice = source.slice(issuesAnchor, issuesAnchor + 600);
    expect(issuesSlice).not.toMatch(/transition-(colors|all)/);
    const prAnchor = source.indexOf("<GitPullRequest");
    const prSlice = source.slice(prAnchor, prAnchor + 600);
    expect(prSlice).not.toMatch(/transition-(colors|all)/);
  });
});

/**
 * Digit flash CSS — the 800ms color decay keyframes and three-layer
 * reduced-motion suppression. Asserted at the source level for the same
 * reason as the toolbar tests above (jsdom render of the toolbar's eager
 * dynamic-import effect causes EnvironmentTeardownError).
 */
const INDEX_CSS_PATH = path.resolve(__dirname, "../../../index.css");

describe("GitHubStatsToolbarButton digit flash CSS", () => {
  let css: string;

  beforeEach(async () => {
    css = await fs.readFile(INDEX_CSS_PATH, "utf-8");
  });

  it("defines @keyframes for issues and PRs using domain CSS variables", () => {
    expect(css).toMatch(/@keyframes\s+github-stat-count-flash-issues/);
    expect(css).toMatch(/@keyframes\s+github-stat-count-flash-prs/);
    const issuesStart = css.indexOf("@keyframes github-stat-count-flash-issues");
    const issuesSlice = css.slice(issuesStart, issuesStart + 300);
    expect(issuesSlice).toContain("var(--color-github-open)");
    expect(issuesSlice).toContain("var(--color-daintree-text)");
    const prsStart = css.indexOf("@keyframes github-stat-count-flash-prs");
    const prsSlice = css.slice(prsStart, prsStart + 300);
    expect(prsSlice).toContain("var(--color-github-merged)");
    expect(prsSlice).toContain("var(--color-daintree-text)");
  });

  it("uses 800ms forwards animation on both flash classes", () => {
    expect(css).toMatch(
      /\.github-stat-count-flash-issues\s*\{[^}]*animation:\s*github-stat-count-flash-issues\s+800ms\s+ease-out\s+forwards/
    );
    expect(css).toMatch(
      /\.github-stat-count-flash-prs\s*\{[^}]*animation:\s*github-stat-count-flash-prs\s+800ms\s+ease-out\s+forwards/
    );
  });

  it("suppresses flash under @media (prefers-reduced-motion: reduce)", () => {
    // The flash classes must appear inside *some* prefers-reduced-motion
    // block with an `animation: none` rule. Walk the file looking for one.
    const matches = [
      ...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const sliceContaining = matches
      .map((m) => {
        // Bracket-balance walk to find the matching closing brace.
        let depth = 1;
        let i = m.index! + m[0].length;
        while (i < css.length && depth > 0) {
          if (css[i] === "{") depth++;
          else if (css[i] === "}") depth--;
          i++;
        }
        return css.slice(m.index!, i);
      })
      .find(
        (block) =>
          block.includes(".github-stat-count-flash-issues") &&
          block.includes(".github-stat-count-flash-prs")
      );
    expect(sliceContaining).toBeDefined();
    expect(sliceContaining!).toMatch(/animation:\s*none/);
  });

  it("suppresses flash under body[data-reduce-animations='true']", () => {
    const reduceBlock = css.match(
      /body\[data-reduce-animations="true"\][\s\S]*?:is\([\s\S]*?\.github-stat-count-flash-issues[\s\S]*?\.github-stat-count-flash-prs[\s\S]*?\)/
    );
    expect(reduceBlock).not.toBeNull();
  });
});
