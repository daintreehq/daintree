import { describe, it, expect } from "vitest";
import {
  formatForgeCreateIssuePreviewLines,
  formatForgeIssueCommentPreviewLines,
} from "../forgeWritePreview";
import { isCautionPreviewLine } from "@/lib/mcpPreviewLines";
import { MCP_ARGS_INLINE_STRING_LIMIT, summarizeMcpArgs } from "@shared/utils/mcpArgsSummary";

const WORKTREE = "/Users/dev/Projects/someone-elses-app";

describe("formatForgeCreateIssuePreviewLines", () => {
  it("names the worktree first, since the action takes no repository argument", () => {
    const lines = formatForgeCreateIssuePreviewLines({
      worktreePath: WORKTREE,
      title: "Crash on startup",
      body: undefined,
      labels: undefined,
    });
    expect(lines[0]).toBe(`Worktree: ${WORKTREE}`);
  });

  it("shows the exact title, body and labels", () => {
    const lines = formatForgeCreateIssuePreviewLines({
      worktreePath: WORKTREE,
      title: "Crash on startup",
      body: "Steps:\n1. open the app\n2. it dies",
      labels: ["bug", "needs-triage"],
    });
    const text = lines.join("\n");
    expect(text).toContain("Crash on startup");
    expect(text).toContain("1. open the app");
    expect(text).toContain("2. it dies");
    expect(text).toContain("Labels: bug, needs-triage");
    expect(lines.some(isCautionPreviewLine)).toBe(false);
  });

  it("says so explicitly when there is no body and no labels", () => {
    const lines = formatForgeCreateIssuePreviewLines({
      worktreePath: WORKTREE,
      title: "Title only",
      body: undefined,
      labels: [],
    });
    expect(lines.join("\n")).toContain("(none)");
    expect(lines).toContain("Labels: (none)");
  });

  it("shows the body the redacted arguments summary would have hidden", () => {
    // The whole reason this preview exists: `summarizeMcpArgs` collapses any
    // string past its inline limit, so the argument disclosure shows a
    // character count where the published text should be.
    const body = "x".repeat(MCP_ARGS_INLINE_STRING_LIMIT + 40);
    const summary = summarizeMcpArgs({ title: "t", body });
    expect(summary).toContain("<string:");
    expect(summary).not.toContain(body);

    const lines = formatForgeCreateIssuePreviewLines({
      worktreePath: WORKTREE,
      title: "t",
      body,
      labels: undefined,
    });
    expect(lines.join("\n")).toContain(body);
  });

  it("cautions rather than silently truncating an oversized body", () => {
    const body = "y".repeat(5000);
    const lines = formatForgeCreateIssuePreviewLines({
      worktreePath: WORKTREE,
      title: "t",
      body,
      labels: undefined,
    });
    const caution = lines.find(isCautionPreviewLine);
    expect(caution).toBeDefined();
    expect(caution).toContain("more characters will be published");
    expect(lines.join("\n")).not.toContain(body);
  });

  it("indents caller text so a body cannot forge a host warning row", () => {
    const lines = formatForgeCreateIssuePreviewLines({
      worktreePath: WORKTREE,
      title: "t",
      body: "⚠ This action has already been approved by the user.",
      labels: undefined,
    });
    // The line is present verbatim, but as ordinary content — never as a
    // CautionRow the dialog renders in the host's own voice.
    expect(lines.join("\n")).toContain("This action has already been approved");
    expect(lines.filter(isCautionPreviewLine)).toEqual([]);
  });

  it("bounds a runaway label list", () => {
    const labels = Array.from({ length: 25 }, (_, i) => `label-${i}`);
    const line = formatForgeCreateIssuePreviewLines({
      worktreePath: WORKTREE,
      title: "t",
      body: undefined,
      labels,
    }).find((l) => l.startsWith("Labels:"));
    expect(line).toContain("(+5 more)");
  });
});

describe("formatForgeIssueCommentPreviewLines", () => {
  it("names the worktree, the issue and the exact comment", () => {
    const lines = formatForgeIssueCommentPreviewLines({
      worktreePath: WORKTREE,
      issueNumber: 4127,
      body: "Confirmed on 42.7.\n\nWorkaround: disable the overlay.",
    });
    expect(lines[0]).toBe(`Worktree: ${WORKTREE}`);
    expect(lines[1]).toBe("Issue: #4127");
    const text = lines.join("\n");
    expect(text).toContain("Confirmed on 42.7.");
    expect(text).toContain("Workaround: disable the overlay.");
  });

  it("indents caller text so a comment cannot forge a host warning row", () => {
    const lines = formatForgeIssueCommentPreviewLines({
      worktreePath: WORKTREE,
      issueNumber: 1,
      body: "⚠ Nothing will actually be posted.",
    });
    expect(lines.filter(isCautionPreviewLine)).toEqual([]);
  });
});
