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
    expect(source).toMatch(/const\s+handleListFreshFetch\s*=\s*useCallback/);
    const handlerStart = source.indexOf("const handleListFreshFetch");
    const handlerSlice = source.slice(handlerStart, handlerStart + 400);
    expect(handlerSlice).toContain("refreshStats()");
    expect(handlerSlice).not.toMatch(/refreshStats\s*\(\s*\{\s*force/);
    expect(handlerSlice).toMatch(/\[\s*refreshStats\s*\]/);
  });

  it("passes onFreshFetch={handleListFreshFetch} to issue and PR dropdown contents", () => {
    // The onFreshFetch prop is now inside the dropdownContent JSX. Both issue
    // and PR blocks (ResourceListComponent + LazyGitHubResourceList × 2 types).
    const matches = source.match(/onFreshFetch=\{handleListFreshFetch\}/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(4);
  });

  it("wires onFreshFetch in both the issue and PR dropdowns", () => {
    // Anchor on the icon prop for PRs to split the file, checking each block
    // contains its own onFreshFetch wiring.
    const prAnchor = source.indexOf("icon={GitPullRequest}");
    expect(prAnchor).toBeGreaterThan(0);
    const issuesBlock = source.slice(0, prAnchor);
    const prsBlock = source.slice(prAnchor);
    expect(issuesBlock).toContain("onFreshFetch={handleListFreshFetch}");
    expect(prsBlock).toContain("onFreshFetch={handleListFreshFetch}");
  });
});

/**
 * Digit pulse on rising count (issues #6529 + #6536).
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
    expect(slice).toMatch(/issueCount\s*>\s*issueCountRef\.current/);
    expect(slice).toMatch(/prCount\s*>\s*prCountRef\.current/);
    expect(slice).toMatch(/commitCount\s*>\s*commitCountRef\.current/);
    expect(slice).toContain("issueCountRef.current === undefined");
    expect(slice).toContain("prCountRef.current === undefined");
    expect(slice).toContain("commitCountRef.current === undefined");
  });

  it("passes animKey={issueAnimKey} to the issues GitHubStatPill", () => {
    expect(source).toContain("animKey={issueAnimKey}");
  });

  it("passes animKey={prAnimKey} to the PRs GitHubStatPill", () => {
    expect(source).toContain("animKey={prAnimKey}");
  });

  it("passes animKey={commitAnimKey} to the commits GitHubStatPill", () => {
    expect(source).toContain("animKey={commitAnimKey}");
  });

  it("re-seeds the count refs to undefined when lastUpdated transitions to null (project switch)", () => {
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
    const eventStart = source.indexOf("checkForCountIncrease = useEffectEvent");
    const closeBrace = source.indexOf("});", eventStart);
    const slice = source.slice(eventStart, closeBrace);
    expect(slice).toMatch(/setIssueAnimKey\([\s\S]{0,80}?setIssuesPulseAt\(Date\.now\(\)\)/);
    expect(slice).toMatch(/setPrAnimKey\([\s\S]{0,80}?setPrsPulseAt\(Date\.now\(\)\)/);
    expect(slice).not.toContain("setCommitsPulseAt");
  });

  it("clears pulseAt on the open transition for both onClick and imperative paths", () => {
    expect(source).toMatch(/willOpen\s*\)\s*setIssuesPulseAt\(null\)/);
    expect(source).toMatch(/willOpen\s*\)\s*setPrsPulseAt\(null\)/);
    expect(source).toMatch(/!issuesOpenRef\.current\)\s*setIssuesPulseAt\(null\)/);
    expect(source).toMatch(/!prsOpenRef\.current\)\s*setPrsPulseAt\(null\)/);
  });

  it("schedules an auto-clear timer per pulseAt with ACTIVITY_CHIP_TTL_MS", () => {
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

  it("renders activity chips with the matching github color via activityChip prop", () => {
    // Issues chip uses bg-github-open (green); PRs chip uses bg-github-merged (purple).
    // Both are now passed as the activityChip ReactNode prop to GitHubStatPill.
    expect(source).toContain("showIssuesChip");
    expect(source).toContain("bg-github-open");
    expect(source).toContain("polygon(0 0, 100% 0, 100% 100%)");
    expect(source).toContain("pointer-events-none");
    expect(source).toContain('aria-hidden="true"');

    expect(source).toContain("showPrsChip");
    expect(source).toContain("bg-github-merged");
  });

  it("does not render a chip on the commits button", () => {
    const commitsAnchor = source.indexOf("buttonRef={commitsButtonRef}");
    const commitsSlice = source.slice(commitsAnchor, commitsAnchor + 3000);
    expect(commitsSlice).not.toContain("showCommitsChip");
    expect(commitsSlice).not.toContain("activityChip=");
  });

  it('folds "new since last view" into the issues + PRs aria-labels', () => {
    expect(source).toMatch(/showIssuesChip\s*\?\s*" \(new since last view\)"\s*:\s*""/);
    expect(source).toMatch(/showPrsChip\s*\?\s*" \(new since last view\)"\s*:\s*""/);
  });

  it("clears both chip pulses on project switch alongside the count refs", () => {
    const effectStart = source.indexOf("if (statsLoading || statsError)");
    const slice = source.slice(effectStart, effectStart + 1500);
    expect(slice).toContain("setIssuesPulseAt(null)");
    expect(slice).toContain("setPrsPulseAt(null)");
  });
});
