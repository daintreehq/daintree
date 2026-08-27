import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const FORGE_STATS_PATH = path.resolve(__dirname, "../ForgeStatsToolbarButton.tsx");
const PLUGIN_DROPDOWN_PATH = path.resolve(
  __dirname,
  "../../../../plugins/builtin/github/renderer/components/GitHubStatsDropdown.tsx"
);

describe("Forge stats dropdown search clearing — issue #3251", () => {
  let pluginSource: string;
  let hostSource: string;

  beforeEach(async () => {
    pluginSource = await fs.readFile(PLUGIN_DROPDOWN_PATH, "utf-8");
    hostSource = await fs.readFile(FORGE_STATS_PATH, "utf-8");
  });

  it("the plugin dropdown view consumes the filter store's search setters", () => {
    expect(pluginSource).toContain("useGitHubFilterStore");
    expect(pluginSource).toContain("setIssueSearchQuery");
    expect(pluginSource).toContain("setPrSearchQuery");
  });

  it("clears the matching search query when the host closes the dropdown (open → false)", () => {
    // The view stays mounted behind a hidden Activity boundary, so the
    // open-prop transition is the only close signal it observes.
    expect(pluginSource).toMatch(/if\s*\(open\)\s*return;/);
    expect(pluginSource).toMatch(/kind === "issues"\)\s*setIssueSearchQuery\(""\)/);
    expect(pluginSource).toMatch(/kind === "prs"\)\s*setPrSearchQuery\(""\)/);
  });

  it("the host threads the open prop into every dropdown slot instance", () => {
    expect(hostSource).toContain("open={issuesOpen}");
    expect(hostSource).toContain("open={prsOpen}");
    expect(hostSource).toContain("open={commitsOpen}");
  });

  it("the host carries no plugin filter-store references", () => {
    expect(hostSource).not.toContain("useGitHubFilterStore");
    expect(hostSource).not.toContain("setIssueSearchQuery");
    expect(hostSource).not.toContain("setPrSearchQuery");
  });
});

describe("Forge stats dropdown skeleton placeholders — issue #3593", () => {
  let pluginSource: string;

  beforeEach(async () => {
    pluginSource = await fs.readFile(PLUGIN_DROPDOWN_PATH, "utf-8");
  });

  it("imports skeleton components synchronously (not lazy)", () => {
    expect(pluginSource).toContain("GitHubResourceListSkeleton");
    expect(pluginSource).toContain("CommitListSkeleton");
    expect(pluginSource).not.toMatch(/lazy\(\s*\(\)\s*=>\s*import.*GitHubDropdownSkeletons/);
  });

  it("uses immediate skeletons while the list chunk loads", () => {
    expect(pluginSource).toMatch(
      /<GitHubResourceListSkeleton\s+count=\{initialCount\}\s+immediate\s+type=\{type\}/
    );
    expect(pluginSource).toMatch(/<CommitListSkeleton\s+count=\{initialCount\}\s+immediate/);
  });

  it("retains the resolved components so reopen skips the placeholder", () => {
    expect(pluginSource).toMatch(/setResourceList\(\(\)\s*=>\s*m\)/);
    expect(pluginSource).toMatch(/setCommitList\(\(\)\s*=>\s*m\)/);
    // A remount (an error-boundary retry, a provider swap) re-reads the loader
    // cache synchronously rather than flashing the skeleton again.
    expect(pluginSource).toContain("loadResourceList.peek()");
    expect(pluginSource).toContain("loadCommitList.peek()");
  });

  it("never falls back to a spinner", () => {
    expect(pluginSource).not.toContain("Loader2");
    expect(pluginSource).not.toContain("Spinner");
  });
});

describe("Forge stats dropdown chunk-load recovery", () => {
  let pluginSource: string;

  beforeEach(async () => {
    pluginSource = await fs.readFile(PLUGIN_DROPDOWN_PATH, "utf-8");
  });

  it("loads the list chunks through retryableImport, never React.lazy", () => {
    // `lazy` memoizes its rejection, so a single missed chunk fetch would
    // disable the dropdown for the rest of the session with no way back.
    expect(pluginSource).toContain("retryableImport");
    expect(pluginSource).not.toMatch(/\blazy\(/);
  });

  it("re-throws a failed load for the slot's error boundary instead of stalling", () => {
    // Swallowing it would leave the skeleton pulsing forever with no recovery.
    expect(pluginSource).toMatch(/if\s*\(loadError\)\s*throw loadError;/);
  });
});

describe("Forge stats token error UX — issue #5024", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(FORGE_STATS_PATH, "utf-8");
  });

  it("consumes isTokenError from useRepositoryStats", () => {
    expect(source).toContain("isTokenError");
    expect(source).toContain("useRepositoryStats");
  });

  it("redirects to the resolved provider's settings subtab on token error click", () => {
    expect(source).toContain("app.settings.openTab");
    expect(source).toMatch(/subtab:\s*providerId/);
  });

  it("dims Issues and PR buttons with opacity-40 on token error", () => {
    const issuesButton = source.slice(
      source.indexOf("buttonRef={issuesButtonRef}"),
      source.indexOf("buttonRef={issuesButtonRef}") + 2500
    );
    expect(issuesButton).toContain("isTokenError");
    expect(issuesButton).toContain("opacity-40");

    const prsButton = source.slice(
      source.indexOf("buttonRef={prsButtonRef}"),
      source.indexOf("buttonRef={prsButtonRef}") + 2500
    );
    expect(prsButton).toContain("isTokenError");
    expect(prsButton).toContain("opacity-40");
  });

  it("does not apply token error handling to the Commits button", () => {
    const commitsButton = source.slice(
      source.indexOf("buttonRef={commitsButtonRef}"),
      source.indexOf("buttonRef={commitsButtonRef}") + 500
    );
    expect(commitsButton).not.toContain("isTokenError");
  });

  it("gates the error indicator on persistent severity, excluding token and rate-limit errors", () => {
    expect(source).toContain('errorSeverity === "persistent" && !isTokenError && !rateLimitActive');
  });
});

describe("Forge stats keepMounted dropdowns — PR #6288", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(FORGE_STATS_PATH, "utf-8");
  });

  it("issues FixedDropdown opts into keepMounted (state preserved across open/close)", () => {
    const issuesPill = source.slice(
      source.indexOf("buttonRef={issuesButtonRef}"),
      source.indexOf("buttonRef={issuesButtonRef}") + 3000
    );
    expect(issuesPill).toContain("keepMounted");
  });

  it("PRs FixedDropdown opts into keepMounted (state preserved across open/close)", () => {
    const prsPill = source.slice(
      source.indexOf("buttonRef={prsButtonRef}"),
      source.indexOf("buttonRef={prsButtonRef}") + 3000
    );
    expect(prsPill).toContain("keepMounted");
  });

  it("commits FixedDropdown does NOT opt into keepMounted (cheaper to remount)", () => {
    const commitsPill = source.slice(
      source.indexOf("buttonRef={commitsButtonRef}"),
      source.indexOf("buttonRef={commitsButtonRef}") + 3000
    );
    expect(commitsPill).not.toContain("keepMounted");
  });
});

describe("Forge stats persistThroughChildOverlays — issue #3556", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(FORGE_STATS_PATH, "utf-8");
  });

  it("issues ForgeStatPill has persistThroughChildOverlays", () => {
    const issuesPill = source.slice(
      source.indexOf("buttonRef={issuesButtonRef}"),
      source.indexOf("buttonRef={issuesButtonRef}") + 3000
    );
    expect(issuesPill).toContain("persistThroughChildOverlays");
  });

  it("PRs ForgeStatPill does NOT have persistThroughChildOverlays", () => {
    const prsPill = source.slice(
      source.indexOf("buttonRef={prsButtonRef}"),
      source.indexOf("buttonRef={prsButtonRef}") + 3000
    );
    expect(prsPill).not.toContain("persistThroughChildOverlays");
  });
});

describe("Commits pill opens without a forge provider — issue #10414", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(FORGE_STATS_PATH, "utf-8");
  });

  it("imports the local commits fallback view", () => {
    expect(source).toMatch(/import \{ LocalCommitsDropdown \} from "\.\/LocalCommitsDropdown"/);
  });

  it("renders LocalCommitsDropdown as the commits dropdown fallback when no provider view exists", () => {
    const commitsPill = source.slice(
      source.indexOf("buttonRef={commitsButtonRef}"),
      source.indexOf("buttonRef={commitsButtonRef}") + 3500
    );
    expect(commitsPill).toContain("LocalCommitsDropdown");
    expect(commitsPill).toContain("open={commitsOpen}");
  });

  it("the commits click handler no longer early-returns without a provider", () => {
    const commitsPill = source.slice(
      source.indexOf("buttonRef={commitsButtonRef}"),
      source.indexOf("buttonRef={commitsButtonRef}") + 3500
    );
    expect(commitsPill).not.toContain("if (!DropdownView || !providerId) return;");
  });

  it("the local fallback carries no forge references", async () => {
    const localSource = await fs.readFile(
      path.resolve(__dirname, "../LocalCommitsDropdown.tsx"),
      "utf-8"
    );
    expect(localSource).not.toContain("GitHub");
    expect(localSource).not.toContain("forgeClient");
    expect(localSource).not.toContain("providerId");
  });
});

describe("Forge neutrality — host carries no GitHub references", () => {
  it("ForgeStatsToolbarButton has no GitHub-specific imports or strings", async () => {
    const source = await fs.readFile(FORGE_STATS_PATH, "utf-8");
    expect(source).not.toContain("GitHub");
    expect(source).not.toContain("github-stats");
    expect(source).not.toContain("@github-renderer");
    expect(source).not.toContain("githubClient");
    expect(source).not.toContain("BUILTIN_GITHUB_PROVIDER_ID");
  });
});
