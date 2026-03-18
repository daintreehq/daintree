import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");

describe("Toolbar GitHub dropdown search clearing — issue #3251", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
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
    // The issues GitHubResourceList onClose should clear the search
    const issuesOnClose = source.slice(
      source.indexOf('type="issue"'),
      source.indexOf('type="issue"') + 300
    );
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

describe("Toolbar persistThroughChildOverlays — issue #3556", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
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
