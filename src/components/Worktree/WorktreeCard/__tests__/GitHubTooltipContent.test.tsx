// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitHubUser, IssueTooltipData, PRTooltipData } from "@shared/types/github";

import { IssueTooltipContent, PRTooltipContent } from "../GitHubTooltipContent";

// Avatar wraps in a Radix tooltip when `title` is set (the assignee stack). Stub
// it so the stacked avatars render without a TooltipProvider in the test tree.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function user(
  login: string,
  avatarUrl = `https://avatars.githubusercontent.com/u/${login}`
): GitHubUser {
  return { login, avatarUrl };
}

const baseIssue: IssueTooltipData = {
  number: 42,
  title: "Something is broken",
  bodyExcerpt: "",
  state: "OPEN",
  createdAt: "2025-06-15T12:00:00Z",
  author: user("octocat"),
  assignees: [],
  labels: [],
};

function imgSrcs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
}

describe("GitHubTooltipContent avatars", () => {
  it("requests a 2x avatar size, appending to a URL with no query string", () => {
    const { container } = render(<IssueTooltipContent data={baseIssue} />);
    const src = imgSrcs(container)[0]!;
    expect(src).toBe("https://avatars.githubusercontent.com/u/octocat?s=28");
  });

  it("preserves an existing query string when adding the size param", () => {
    const data = {
      ...baseIssue,
      author: user("octocat", "https://avatars.githubusercontent.com/u/1?v=4"),
    };
    const { container } = render(<IssueTooltipContent data={data} />);
    const src = imgSrcs(container)[0]!;
    expect(src).toContain("v=4");
    expect(src).toContain("s=28");
    expect(src.startsWith("https://avatars.githubusercontent.com/u/1?")).toBe(true);
    // Single query separator — never a second `?`.
    expect(src.indexOf("?")).toBe(src.lastIndexOf("?"));
  });

  it("replaces an existing s= param rather than duplicating it", () => {
    const data = {
      ...baseIssue,
      author: user("octocat", "https://avatars.githubusercontent.com/u/1?s=40&v=4"),
    };
    const { container } = render(<IssueTooltipContent data={data} />);
    const src = imgSrcs(container)[0]!;
    expect(src).toContain("s=28");
    expect(src).not.toContain("s=40");
    expect(src.match(/s=/g)).toHaveLength(1);
  });

  it("renders the author login next to an avatar image", () => {
    const { container } = render(<IssueTooltipContent data={baseIssue} />);
    expect(screen.getByText("octocat")).toBeDefined();
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("renders a single assignee as avatar + login", () => {
    const data = { ...baseIssue, assignees: [user("alice")] };
    const { container } = render(<IssueTooltipContent data={data} />);
    expect(screen.getByText("alice")).toBeDefined();
    // Author avatar + assignee avatar.
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  it("caps the assignee stack at three avatars with a +N overflow", () => {
    const data = {
      ...baseIssue,
      assignees: [user("alice"), user("bob"), user("carol"), user("dave")],
    };
    const { container } = render(<IssueTooltipContent data={data} />);
    // Author (1) + three stacked assignees (3) = 4 images; the 4th assignee
    // collapses into the overflow count.
    expect(container.querySelectorAll("img")).toHaveLength(4);
    expect(screen.getByText("+1")).toBeDefined();
  });

  it("names every assignee for screen readers even when avatars overflow", () => {
    const data = {
      ...baseIssue,
      assignees: [user("alice"), user("bob"), user("carol"), user("dave")],
    };
    render(<IssueTooltipContent data={data} />);
    expect(screen.getByText("Assigned to alice, bob, carol, dave")).toBeDefined();
  });

  it("handles a missing avatar URL without crashing", () => {
    const data = { ...baseIssue, author: user("ghost", "") };
    const { container } = render(<IssueTooltipContent data={data} />);
    expect(imgSrcs(container)[0]).toBe("");
    expect(screen.getByText("ghost")).toBeDefined();
  });

  it("applies the same avatar treatment to PR tooltips", () => {
    const prData: PRTooltipData = {
      number: 7,
      title: "Add the thing",
      bodyExcerpt: "",
      state: "OPEN",
      isDraft: false,
      createdAt: "2025-06-15T12:00:00Z",
      author: user("octocat"),
      assignees: [user("alice"), user("bob")],
      labels: [],
    };
    const { container } = render(<PRTooltipContent data={prData} />);
    expect(screen.getByText("octocat")).toBeDefined();
    // Author + two stacked assignees.
    expect(container.querySelectorAll("img")).toHaveLength(3);
    expect(screen.getByText("Assigned to alice, bob")).toBeDefined();
  });
});
