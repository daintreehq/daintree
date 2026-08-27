// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ForgeUser, IssueTooltipData, PRTooltipData } from "@shared/types/forge";

import { IssueTooltipContent, PRTooltipContent } from "../ForgeTooltipContent";

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
): ForgeUser {
  return { login, avatarUrl, rawData: null };
}

const baseIssue: IssueTooltipData = {
  number: 42,
  title: "Something is broken",
  bodyExcerpt: "",
  state: "open",
  rawState: "OPEN",
  createdAt: Date.parse("2025-06-15T12:00:00Z"),
  author: user("octocat"),
  assignees: [],
  labels: [],
};

function imgSrcs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
}

describe("ForgeTooltipContent avatars", () => {
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

  it("distinguishes the creator from the assignee role", () => {
    const data = { ...baseIssue, assignees: [user("alice")] };
    render(<IssueTooltipContent data={data} />);
    // Distinct role labels mean the two chips are not interchangeable, even
    // when the same person is both author and assignee.
    expect(screen.getByText("Created by")).toBeDefined();
    expect(screen.getByText("Assigned to")).toBeDefined();
  });

  it("requests smaller avatars for the stacked assignees than for the author", () => {
    const data = {
      ...baseIssue,
      assignees: [user("alice"), user("bob"), user("carol"), user("dave")],
    };
    const { container } = render(<IssueTooltipContent data={data} />);
    const srcs = imgSrcs(container);
    // Author avatar renders first at the larger size; the stack follows at 2x
    // of the smaller rendered size.
    expect(srcs[0]).toContain("s=28");
    expect(srcs.slice(1)).toHaveLength(3);
    for (const src of srcs.slice(1)) {
      expect(src).toContain("s=24");
    }
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
      state: "open",
      rawState: "OPEN",
      isDraft: false,
      createdAt: Date.parse("2025-06-15T12:00:00Z"),
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

const issueData: IssueTooltipData = {
  number: 42,
  title: "Something is broken",
  bodyExcerpt: "Steps to reproduce…",
  state: "open",
  rawState: "OPEN",
  createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
  author: user("octocat"),
  assignees: [],
  labels: [],
};

const prData: PRTooltipData = {
  number: 7,
  title: "Fix the thing",
  bodyExcerpt: "This fixes the thing.",
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
  author: user("octocat"),
  assignees: [],
  labels: [],
};

describe("IssueTooltipContent freshness item", () => {
  it("renders no freshness item when freshness is absent", () => {
    const { container } = render(<IssueTooltipContent data={issueData} />);
    expect(container.querySelector(".lucide-clock")).toBeNull();
    expect(container.querySelector(".lucide-circle-pause")).toBeNull();
    expect(screen.queryByText(/rate limited/)).toBeNull();
  });

  it("renders no freshness item when the cause is undefined", () => {
    const { container } = render(
      <IssueTooltipContent data={issueData} freshness={{ cause: undefined, now: 1000 }} />
    );
    expect(container.querySelector(".lucide-clock")).toBeNull();
    expect(container.querySelector(".lucide-circle-pause")).toBeNull();
  });

  it("folds a rate-limit cause onto the metadata row as a Clock + label", () => {
    const { container } = render(
      <IssueTooltipContent data={issueData} freshness={{ cause: "rate-limit", now: 1000 }} />
    );
    expect(container.querySelector(".lucide-clock")).toBeTruthy();
    expect(screen.getByText(/^rate limited$/)).toBeTruthy();
  });

  it("includes the retry time when a future reset is provided", () => {
    const now = 1000;
    const { container } = render(
      <IssueTooltipContent
        data={issueData}
        freshness={{ cause: "rate-limit", now, rateLimitResetAt: now + 60_000 }}
      />
    );
    expect(container.querySelector(".lucide-clock")).toBeTruthy();
    expect(screen.getByText(/rate limited, retry at /)).toBeTruthy();
  });

  it.each([
    ["null", null],
    ["past", 999],
    ["equal to now", 1000],
    ["non-finite", Number.POSITIVE_INFINITY],
  ])("omits the retry time when reset is %s", (_label, rateLimitResetAt) => {
    render(
      <IssueTooltipContent
        data={issueData}
        freshness={{ cause: "rate-limit", now: 1000, rateLimitResetAt }}
      />
    );
    expect(screen.getByText("rate limited")).toBeTruthy();
    expect(screen.queryByText(/retry at/)).toBeNull();
  });

  it("renders a single freshness item — no duplicate when data is present", () => {
    const { container } = render(
      <IssueTooltipContent data={issueData} freshness={{ cause: "rate-limit", now: 1000 }} />
    );
    expect(container.querySelectorAll(".lucide-clock")).toHaveLength(1);
  });

  it("renders a circuit-breaker cause as a PauseCircle, not a Clock", () => {
    const { container } = render(
      <IssueTooltipContent data={issueData} freshness={{ cause: "circuit-breaker", now: 1000 }} />
    );
    expect(container.querySelector(".lucide-circle-pause")).toBeTruthy();
    expect(container.querySelector(".lucide-clock")).toBeNull();
    expect(screen.getByText(/data may be stale/)).toBeTruthy();
  });
});

describe("PRTooltipContent freshness item", () => {
  it("renders no freshness item when freshness is absent", () => {
    const { container } = render(<PRTooltipContent data={prData} />);
    expect(container.querySelector(".lucide-clock")).toBeNull();
    expect(container.querySelector(".lucide-circle-pause")).toBeNull();
  });

  it("folds a rate-limit cause onto the metadata row as a Clock + label", () => {
    const { container } = render(
      <PRTooltipContent data={prData} freshness={{ cause: "rate-limit", now: 1000 }} />
    );
    expect(container.querySelector(".lucide-clock")).toBeTruthy();
    expect(screen.getByText(/^rate limited$/)).toBeTruthy();
  });

  it("renders a circuit-breaker cause as a PauseCircle", () => {
    const { container } = render(
      <PRTooltipContent data={prData} freshness={{ cause: "circuit-breaker", now: 1000 }} />
    );
    expect(container.querySelector(".lucide-circle-pause")).toBeTruthy();
    expect(screen.getByText(/data may be stale/)).toBeTruthy();
  });
});

describe("ForgeTooltipContent labels", () => {
  // The forge queries ask for `labels(first: 10)`, so this is the widest row
  // either tooltip can be handed.
  const manyLabels = Array.from({ length: 10 }, (_, i) => ({
    name: `label-${i}`,
    color: "8b949e",
  }));

  it("renders every issue label rather than counting the tail (#12001)", () => {
    // The row used to stop at four and print "+N more" — a count inside a
    // hover tooltip, which has no further surface to open.
    render(<IssueTooltipContent data={{ ...issueData, labels: manyLabels }} />);
    for (const label of manyLabels) {
      expect(screen.getByText(label.name)).toBeTruthy();
    }
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("renders every PR label rather than counting the tail (#12001)", () => {
    render(<PRTooltipContent data={{ ...prData, labels: manyLabels }} />);
    for (const label of manyLabels) {
      expect(screen.getByText(label.name)).toBeTruthy();
    }
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("renders no label row at all when there are no labels", () => {
    const withLabels = render(<IssueTooltipContent data={{ ...issueData, labels: manyLabels }} />);
    const withLabelsNodes = withLabels.container.querySelectorAll("div").length;
    cleanup();

    const empty = render(<IssueTooltipContent data={{ ...issueData, labels: [] }} />);
    // An empty row shell would still take the row's `pt-1`, opening a gap under
    // the metadata line for nothing.
    expect(empty.container.querySelectorAll("div").length).toBeLessThan(withLabelsNodes);
  });

  it("bounds the row when a provider returns far more labels than a forge page", () => {
    // `ForgeLabel[]` is unbounded in the provider contract and a tooltip can't
    // scroll, so an unbounded row would run past the viewport and be clipped by
    // the tooltip's own overflow.
    const flood = Array.from({ length: 300 }, (_, i) => ({ name: `flood-${i}`, color: "8b949e" }));
    const { container } = render(<IssueTooltipContent data={{ ...issueData, labels: flood }} />);

    const rendered = container.textContent ?? "";
    const chips = flood.filter((l) => screen.queryByText(l.name) !== null);
    expect(chips.length).toBeLessThan(flood.length);
    // And it names the route rather than counting a remainder: a tooltip has no
    // surface of its own to open, but the badge it describes opens the item.
    expect(rendered).toContain(String(flood.length));
    expect(rendered).toContain("open the issue");
    expect(rendered).not.toMatch(/\+\d+ more/);
  });

  it("names the pull request, not the issue, on a PR tooltip", () => {
    const flood = Array.from({ length: 40 }, (_, i) => ({ name: `flood-${i}`, color: "8b949e" }));
    const { container } = render(<PRTooltipContent data={{ ...prData, labels: flood }} />);
    expect(container.textContent).toContain("open the pull request");
  });

  it("falls back to a neutral colour for a label the provider left uncoloured", () => {
    render(<IssueTooltipContent data={{ ...issueData, labels: [{ name: "uncoloured" }] }} />);
    const badge = screen.getByText("uncoloured");
    // Any resolved colour beats none: an unset `color` used to produce
    // `#undefined20`, which paints nothing.
    expect(badge.getAttribute("style") ?? "").not.toContain("undefined");
  });
});
