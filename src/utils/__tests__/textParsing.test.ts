import { describe, it, expect } from "vitest";
import { parseNoteWithLinks, middleTruncatePath, truncateBranchName } from "../textParsing";

describe("parseNoteWithLinks", () => {
  it("should return a single text segment for plain text", () => {
    const result = parseNoteWithLinks("hello world");
    expect(result).toEqual([{ type: "text", content: "hello world", start: 0 }]);
  });

  it("should return a single link segment for a standalone URL", () => {
    const result = parseNoteWithLinks("https://example.com");
    expect(result).toEqual([{ type: "link", content: "https://example.com", start: 0 }]);
  });

  it("should parse text with an embedded URL", () => {
    const result = parseNoteWithLinks("Visit https://example.com for details");
    expect(result).toEqual([
      { type: "text", content: "Visit ", start: 0 },
      { type: "link", content: "https://example.com", start: 6 },
      { type: "text", content: " for details", start: 25 },
    ]);
  });

  it("should parse multiple URLs with correct start offsets", () => {
    const result = parseNoteWithLinks("See https://a.com and https://b.com end");
    expect(result).toEqual([
      { type: "text", content: "See ", start: 0 },
      { type: "link", content: "https://a.com", start: 4 },
      { type: "text", content: " and ", start: 17 },
      { type: "link", content: "https://b.com", start: 22 },
      { type: "text", content: " end", start: 35 },
    ]);
  });

  it("should handle duplicate URLs at different offsets", () => {
    const result = parseNoteWithLinks("https://a.com https://a.com");
    expect(result).toEqual([
      { type: "link", content: "https://a.com", start: 0 },
      { type: "text", content: " ", start: 13 },
      { type: "link", content: "https://a.com", start: 14 },
    ]);
  });

  it("should handle URL at start with trailing text", () => {
    const result = parseNoteWithLinks("https://start.com is first");
    expect(result).toEqual([
      { type: "link", content: "https://start.com", start: 0 },
      { type: "text", content: " is first", start: 17 },
    ]);
  });

  it("should handle URL at end with leading text", () => {
    const result = parseNoteWithLinks("check out https://end.com");
    expect(result).toEqual([
      { type: "text", content: "check out ", start: 0 },
      { type: "link", content: "https://end.com", start: 10 },
    ]);
  });

  it("should satisfy round-trip invariant: segments reconstruct the original string", () => {
    const input = "Hello https://a.com world https://b.com!";
    const result = parseNoteWithLinks(input);

    const reconstructed = result.map((s) => s.content).join("");
    expect(reconstructed).toBe(input);

    for (const segment of result) {
      expect(input.slice(segment.start, segment.start + segment.content.length)).toBe(
        segment.content
      );
    }
  });

  it("should return empty array for empty string", () => {
    const result = parseNoteWithLinks("");
    expect(result).toEqual([]);
  });
});

describe("middleTruncatePath", () => {
  /**
   * The rule: whatever gets dropped, the end survives. CSS `truncate` cuts the
   * right-hand side, which is where the filename and line number live — the
   * part the user came for.
   */
  it("keeps the filename and line when a path is too long", () => {
    const path = "src/routes/marketing/campaigns/spring/pricing/+page.svelte:126";
    const short = middleTruncatePath(path, 40);
    expect(short.length).toBeLessThanOrEqual(41);
    expect(short.endsWith("+page.svelte:126")).toBe(true);
    expect(short).toContain("…");
  });

  it("leaves a path that already fits completely alone", () => {
    const path = "src/routes/+page.svelte:6";
    expect(middleTruncatePath(path, 40)).toBe(path);
  });

  it("keeps the end even when the filename alone exceeds the budget", () => {
    const path = "src/AbsurdlyLongComponentNameThatGoesOnForever.svelte:12";
    const short = middleTruncatePath(path, 20);
    expect(short.endsWith("Forever.svelte:12")).toBe(true);
  });
});

describe("truncateBranchName", () => {
  const BRANCHES = [
    "feature/12593-multi-window-open-routing-dock-drop",
    "fix/11958-worktree-sidebar-rail-overflow-at-narrow-widths",
    "design/project-pill-with-a-very-long-descriptive-slug",
    "12345-ticket-first-with-no-prefix-at-all-here",
    "feature/9999999999999999999999-overlong-ticket",
    "renovate/major-typescript-eslint-monorepo",
    "wip/🌴-emoji-in-a-branch-name-that-is-long",
  ];

  it("leaves a name within the budget untouched", () => {
    expect(truncateBranchName("develop", 24)).toBe("develop");
    const exact = "a".repeat(24);
    expect(truncateBranchName(exact, 24)).toBe(exact);
  });

  it("fits the budget exactly, with one ellipsis character, keeping a real head and tail", () => {
    for (const branch of BRANCHES) {
      const out = truncateBranchName(branch, 24);
      const chars = Array.from(out);
      expect(chars.length, out).toBe(24);
      expect(out.split("…").length - 1, out).toBe(1);
      expect(out).not.toContain("...");
      const [head, tail] = out.split("…") as [string, string];
      expect(branch.startsWith(head), out).toBe(true);
      expect(branch.endsWith(tail), out).toBe(true);
    }
  });

  it("keeps two branches that differ early distinguishable", () => {
    const pairs: [string, string][] = [
      [
        "release/2026-09-production-compatibility-rollout",
        "release/2026-10-production-compatibility-rollout",
      ],
      [
        "v2-1-maintenance-branch-for-the-old-api-line",
        "v2-2-maintenance-branch-for-the-old-api-line",
      ],
    ];
    for (const [a, b] of pairs) {
      expect(truncateBranchName(a, 24), a).not.toBe(truncateBranchName(b, 24));
    }
  });

  it("keeps a leading ticket or date run whole when there is room left for the slug", () => {
    for (const branch of BRANCHES) {
      const ticket = /^(?:[^/]+\/)?(\d+(?:[-_.]\d+)*)[-_]/.exec(branch);
      if (!ticket || ticket[0].length + 7 > 24) continue;
      expect(truncateBranchName(branch, 24).split("…")[0], branch).toContain(ticket[1]);
    }
  });
});
