import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const GITHUB_STATS_PATH = path.resolve(__dirname, "../GitHubStatsToolbarButton.tsx");

describe("Toolbar GitHub dropdown search clearing — issue #3251", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(GITHUB_STATS_PATH, "utf-8");
  });

  it("imports useGitHubFilterStore", () => {
    expect(source).toContain("useGitHubFilterStore");
  });

  it("destructures setIssueSearchQuery from the store", () => {
    expect(source).toContain("setIssueSearchQuery");
  });

  it("destructures setPrSearchQuery from the store", () => {
    expect(source).toContain("setPrSearchQuery");
  });

  it("clears issue search query in onOpenChange callback", () => {
    // The issues FixedDropdown onOpenChange should clear the search
    const issuesDropdown = source.slice(
      source.indexOf("onOpenChange={(open) => {"),
      source.indexOf("onOpenChange={(open) => {") + 200
    );
    expect(issuesDropdown).toContain('setIssueSearchQuery("")');
  });

  it("clears issue search query in onClose callback", () => {
    // Find the LazyGitHubResourceList occurrence (second type="issue"), not the skeleton (first)
    const firstIssueIdx = source.indexOf('type="issue"');
    const lazyIssueIdx = source.indexOf('type="issue"', firstIssueIdx + 1);
    const issuesOnClose = source.slice(lazyIssueIdx, lazyIssueIdx + 300);
    expect(issuesOnClose).toContain('setIssueSearchQuery("")');
  });

  it("clears PR search query in PR onOpenChange callback", () => {
    // Find the second onOpenChange (for PRs dropdown)
    const firstIdx = source.indexOf("onOpenChange={(open) => {");
    const secondIdx = source.indexOf("onOpenChange={(open) => {", firstIdx + 1);
    const prsDropdown = source.slice(secondIdx, secondIdx + 200);
    expect(prsDropdown).toContain('setPrSearchQuery("")');
  });

  it("clears PR search query in PR onClose callback", () => {
    const prsOnClose = source.slice(source.indexOf('type="pr"'), source.indexOf('type="pr"') + 300);
    expect(prsOnClose).toContain('setPrSearchQuery("")');
  });

  it("clears PR search when issues button closes PRs", () => {
    // Issues button onClick closes PRs, should also clear PR search
    const issuesButton = source.slice(
      source.indexOf("ref={issuesButtonRef}"),
      source.indexOf("ref={issuesButtonRef}") + 500
    );
    expect(issuesButton).toContain('setPrSearchQuery("")');
  });

  it("clears issue search when PR button closes issues", () => {
    // PR button onClick closes issues, should also clear issue search
    const prsButton = source.slice(
      source.indexOf("ref={prsButtonRef}"),
      source.indexOf("ref={prsButtonRef}") + 500
    );
    expect(prsButton).toContain('setIssueSearchQuery("")');
  });

  it("clears both search queries when commits button closes both", () => {
    const commitsButton = source.slice(
      source.indexOf("ref={commitsButtonRef}"),
      source.indexOf("ref={commitsButtonRef}") + 500
    );
    expect(commitsButton).toContain('setIssueSearchQuery("")');
    expect(commitsButton).toContain('setPrSearchQuery("")');
  });
});

describe("Toolbar Suspense skeleton fallbacks — issue #3593", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(GITHUB_STATS_PATH, "utf-8");
  });

  it("imports skeleton components synchronously (not lazy)", () => {
    expect(source).toContain("GitHubResourceListSkeleton");
    expect(source).toContain("CommitListSkeleton");
    expect(source).not.toMatch(/lazy\(\s*\(\)\s*=>\s*import.*GitHubDropdownSkeletons/);
  });

  it("uses GitHubResourceListSkeleton with immediate in issues Suspense fallback", () => {
    // The PR #6288 eager-chunk-loading path introduced an additional
    // `type="issue"` reference before the Suspense fallback. Anchor on the
    // skeleton tag itself so this test stays robust to future toolbar shape
    // changes.
    expect(source).toMatch(
      /<GitHubResourceListSkeleton\s+count=\{stats\?\.issueCount\}\s+immediate\s+type="issue"/
    );
  });

  it("uses GitHubResourceListSkeleton with immediate in PRs Suspense fallback", () => {
    expect(source).toMatch(
      /<GitHubResourceListSkeleton\s+count=\{stats\?\.prCount\}\s+immediate\s+type="pr"/
    );
  });

  it("uses CommitListSkeleton with immediate in commits Suspense fallback", () => {
    // Find the LazyCommitList usage inside the JSX (not the lazy() declaration at top)
    const firstLazy = source.indexOf("LazyCommitList");
    const jsxLazy = source.indexOf("LazyCommitList", firstLazy + 1);
    const commitsSuspense = source.slice(jsxLazy - 300, jsxLazy);
    expect(commitsSuspense).toContain("CommitListSkeleton");
    expect(commitsSuspense).toContain("immediate");
  });

  it("does not use Loader2 in any Suspense fallback", () => {
    const suspenseBlocks = source.match(/fallback=\{[\s\S]*?\}\s*>/g) ?? [];
    for (const block of suspenseBlocks) {
      expect(block).not.toContain("Loader2");
    }
  });
});

describe("Toolbar GitHub token error UX — issue #5024", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(GITHUB_STATS_PATH, "utf-8");
  });

  it("consumes isTokenError from useRepositoryStats", () => {
    expect(source).toContain("isTokenError");
    expect(source).toContain("useRepositoryStats");
  });

  it("redirects to GitHub settings on token error click", () => {
    expect(source).toContain("app.settings.openTab");
    expect(source).toContain("github-token");
  });

  it("dims Issues and PR buttons with opacity-40 on token error", () => {
    // Slice extends past `</Button>` to survive growth in the button body —
    // the PR #6288 hover-prefetch handlers pushed the className block past
    // the original 1500-char window.
    const issuesButton = source.slice(
      source.indexOf("ref={issuesButtonRef}"),
      source.indexOf("ref={issuesButtonRef}") + 2500
    );
    expect(issuesButton).toContain("isTokenError");
    expect(issuesButton).toContain("opacity-40");

    const prsButton = source.slice(
      source.indexOf("ref={prsButtonRef}"),
      source.indexOf("ref={prsButtonRef}") + 2500
    );
    expect(prsButton).toContain("isTokenError");
    expect(prsButton).toContain("opacity-40");
  });

  it("does not apply token error handling to the Commits button", () => {
    const commitsButton = source.slice(
      source.indexOf("ref={commitsButtonRef}"),
      source.indexOf("ref={commitsButtonRef}") + 500
    );
    expect(commitsButton).not.toContain("isTokenError");
  });

  it("suppresses error indicator status for token errors", () => {
    expect(source).toContain("statsError && !isTokenError");
  });
});

describe("Toolbar keepMounted dropdowns — PR #6288", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(GITHUB_STATS_PATH, "utf-8");
  });

  it("issues FixedDropdown opts into keepMounted (state preserved across open/close)", () => {
    const issuesDropdownStart = source.indexOf('type="issue"');
    const preceding = source.slice(Math.max(0, issuesDropdownStart - 800), issuesDropdownStart);
    const lastFixedDropdown = preceding.lastIndexOf("<FixedDropdown");
    const dropdownTag = preceding.slice(lastFixedDropdown);
    expect(dropdownTag).toContain("keepMounted");
  });

  it("PRs FixedDropdown opts into keepMounted (state preserved across open/close)", () => {
    const prDropdownStart = source.indexOf('type="pr"');
    const preceding = source.slice(Math.max(0, prDropdownStart - 800), prDropdownStart);
    const lastFixedDropdown = preceding.lastIndexOf("<FixedDropdown");
    const dropdownTag = preceding.slice(lastFixedDropdown);
    expect(dropdownTag).toContain("keepMounted");
  });

  it("commits FixedDropdown does NOT opt into keepMounted (cheaper to remount)", () => {
    const commitsButtonRefIdx = source.indexOf("ref={commitsButtonRef}");
    const lookahead = source.slice(commitsButtonRefIdx);
    const fixedDropdownIdx = lookahead.indexOf("<FixedDropdown");
    expect(fixedDropdownIdx).toBeGreaterThanOrEqual(0);
    const tagEnd = lookahead.indexOf(">", fixedDropdownIdx);
    const tag = lookahead.slice(fixedDropdownIdx, tagEnd + 1);
    expect(tag).not.toContain("keepMounted");
  });
});

describe("Toolbar persistThroughChildOverlays — issue #3556", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(GITHUB_STATS_PATH, "utf-8");
  });

  it("issues FixedDropdown has persistThroughChildOverlays", () => {
    const issuesDropdownStart = source.indexOf('type="issue"');
    const preceding = source.slice(Math.max(0, issuesDropdownStart - 500), issuesDropdownStart);
    expect(preceding).toContain("persistThroughChildOverlays");
  });

  it("PRs FixedDropdown does NOT have persistThroughChildOverlays", () => {
    const prDropdownStart = source.indexOf('type="pr"');
    const preceding = source.slice(Math.max(0, prDropdownStart - 500), prDropdownStart);
    const lastFixedDropdown = preceding.lastIndexOf("<FixedDropdown");
    const prDropdownBlock = preceding.slice(lastFixedDropdown);
    expect(prDropdownBlock).not.toContain("persistThroughChildOverlays");
  });
});
