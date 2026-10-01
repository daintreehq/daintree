// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatch = vi.fn(
  (
    _id: string,
    _args?: unknown,
    _options?: unknown
  ): Promise<{ ok: boolean; error?: { message: string } }> => Promise.resolve({ ok: true })
);
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args?: unknown, options?: unknown) => dispatch(id, args, options),
  },
}));

const logError = vi.fn();
vi.mock("@/utils/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/logger")>()),
  logError: (...args: unknown[]) => logError(...args),
}));

import * as kit from "@daintreehq/plugin-ui";
import type { CheckRun, Commit, WorktreeItem } from "@daintreehq/plugin-ui";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  checksSummary,
  ciLook,
  forgeStateLook,
  portLinkUrl,
  resolveFileLink,
} from "@/components/PluginKit/PluginKitGit";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

beforeEach(() => dispatch.mockClear());
afterEach(cleanup);

function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function withTooltips(children: ReactNode) {
  return createElement(TooltipProvider, null, children);
}

const WORKTREES: WorktreeItem[] = [
  { id: "main", name: "daintree", branch: "develop", path: "/repo", isMainWorktree: true },
  {
    id: "wt-1",
    name: "native-git",
    branch: "feature/native-git",
    path: "/repo/.worktrees/native-git",
    isCurrent: true,
    aheadCount: 3,
    behindCount: 1,
    status: { changedFileCount: 4 },
  },
  { id: "wt-2", name: "fix-crash", branch: "bugfix/crash", path: "/repo/.worktrees/fix-crash" },
];

describe("GitStatusBadge", () => {
  it("letters each status in the host's colour and names it", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.GitStatusBadge, { status: "modified", "data-testid": "m" }),
        createElement(kit.GitStatusBadge, { status: "conflicted", "data-testid": "c" }),
        createElement(kit.GitStatusBadge, { status: "untracked", "data-testid": "u" })
      )
    );
    const m = screen.getByTestId("m");
    expect(m.textContent).toBe("M");
    expect(m.getAttribute("aria-label")).toBe("Modified");
    expect(m.className).toContain("text-status-warning");
    expect(screen.getByTestId("c").textContent).toBe("!");
    expect(screen.getByTestId("c").className).toContain("text-status-error");
    expect(screen.getByTestId("u").textContent).toBe("?");
  });

  it("spells the word out in the label variant and draws nothing for an unknown status", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.GitStatusBadge, {
          status: "renamed",
          variant: "label",
          "data-testid": "r",
        }),
        untyped("GitStatusBadge", { status: "exploded", "data-testid": "x" })
      )
    );
    expect(screen.getByTestId("r").textContent).toBe("RRenamed");
    expect(screen.getByTestId("r").getAttribute("role")).toBeNull();
    expect(screen.queryByTestId("x")).toBeNull();
  });
});

describe("FileIcon", () => {
  it("draws the tree's glyph for the name, decorative unless named", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.FileIcon, { path: "src/app.tsx", "data-testid": "a" }),
        createElement(kit.FileIcon, {
          path: "src",
          kind: "directory",
          expanded: true,
          size: 20,
          "aria-label": "Folder",
          "data-testid": "b",
        })
      )
    );
    const a = screen.getByTestId("a");
    expect(a.getAttribute("aria-hidden")).toBe("true");
    expect(a.querySelector("svg")?.classList.contains("file-tree-entry-icon")).toBe(true);
    const b = screen.getByTestId("b");
    expect(b.getAttribute("role")).toBe("img");
    expect(b.getAttribute("aria-label")).toBe("Folder");
    expect(b.querySelector("svg")?.getAttribute("style")).toContain("width: 20px");
  });

  it("gives different categories different glyphs", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.FileIcon, { path: "a.ts", "data-testid": "ts" }),
        createElement(kit.FileIcon, { path: "a.png", "data-testid": "png" })
      )
    );
    expect(screen.getByTestId("ts").innerHTML).not.toBe(screen.getByTestId("png").innerHTML);
  });
});

describe("FileLink", () => {
  it("resolves paths inside the root only", () => {
    expect(resolveFileLink("src/a.ts", "/repo")).toBe("/repo/src/a.ts");
    expect(resolveFileLink("/repo/b.ts", "/repo")).toBe("/repo/b.ts");
    expect(resolveFileLink("../etc/passwd", "/repo")).toBeNull();
    expect(resolveFileLink("/etc/passwd", "/repo")).toBeNull();
    expect(resolveFileLink("a.ts", "relative")).toBeNull();
    expect(resolveFileLink("a.ts", undefined)).toBeNull();
  });

  it("opens the file in the host viewer at the line, confined to the root", () => {
    render(
      withTooltips(
        createElement(kit.FileLink, {
          path: "src/lib/util.ts",
          rootPath: "/repo",
          line: 42,
          "data-testid": "link",
        })
      )
    );
    const link = screen.getByTestId("link");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("aria-label")).toBe("src/lib/util.ts, line 42");
    expect(link.textContent).toContain(":42");
    fireEvent.click(link);
    expect(dispatch).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/src/lib/util.ts", rootPath: "/repo", confineToRoot: true, line: 42 },
      { source: "user" }
    );
  });

  it("draws an escaping path as plain text with no link", () => {
    render(
      withTooltips(
        createElement(kit.FileLink, {
          path: "../secret.txt",
          rootPath: "/repo",
          "data-testid": "t",
        })
      )
    );
    const text = screen.getByTestId("t");
    expect(text.tagName).toBe("SPAN");
    fireEvent.click(text);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets the author's click take over", () => {
    const onClick = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    render(
      withTooltips(
        createElement(kit.FileLink, {
          path: "a.ts",
          rootPath: "/repo",
          onClick,
          icon: false,
          "data-testid": "link",
        })
      )
    );
    const link = screen.getByTestId("link");
    expect(link.querySelector("svg")).toBeNull();
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("BranchBadge and WorktreeBadge", () => {
  it("draws the host's branch badge and nothing for an empty name", () => {
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.BranchBadge, { branch: "feature/x", "data-testid": "b" }),
          untyped("BranchBadge", { branch: "", "data-testid": "none" })
        )
      )
    );
    expect(screen.getByTestId("b").textContent).toBe("feature/x");
    expect(screen.getByTestId("b").querySelector(".font-mono")).not.toBeNull();
    expect(screen.queryByTestId("none")).toBeNull();
  });

  it("shows name, branch, current and how far it has moved", () => {
    render(
      withTooltips(
        createElement(kit.WorktreeBadge, { worktree: WORKTREES[1]!, "data-testid": "w" })
      )
    );
    const badge = screen.getByTestId("w");
    expect(badge.textContent).toContain("native-git");
    expect(badge.textContent).toContain("feature/native-git");
    expect(badge.textContent).toContain("Current");
    const sync = badge.querySelector("[data-kit-worktree-sync]");
    expect(sync?.getAttribute("aria-label")).toBe("4 changed files, 3 ahead, 1 behind");
    expect(sync?.textContent).toContain("↑3");
    expect(sync?.textContent).toContain("↓1");
  });

  it("hides the branch when asked or when it is the name, and ignores bad input", () => {
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.WorktreeBadge, {
            worktree: { id: "a", branch: "main" },
            "data-testid": "a",
          }),
          createElement(kit.WorktreeBadge, {
            worktree: WORKTREES[1]!,
            showBranch: false,
            showStatus: false,
            "data-testid": "b",
          }),
          untyped("WorktreeBadge", { worktree: { name: "no id" }, "data-testid": "c" })
        )
      )
    );
    expect(screen.getByTestId("a").textContent).toBe("main");
    expect(screen.getByTestId("b").textContent).not.toContain("feature/native-git");
    expect(screen.getByTestId("b").querySelector("[data-kit-worktree-sync]")).toBeNull();
    expect(screen.queryByTestId("c")).toBeNull();
  });
});

describe("WorktreePicker", () => {
  function Controlled({ onChange }: { onChange: (id: string) => void }) {
    const [value, setValue] = useState<string | null>("wt-1");
    return createElement(kit.WorktreePicker, {
      worktrees: WORKTREES,
      value,
      onValueChange: (id: string) => {
        setValue(id);
        onChange(id);
      },
      "aria-label": "Worktree",
    });
  }

  it("shows the chosen worktree on the trigger and lists every one grouped, current marked", () => {
    render(withTooltips(createElement(Controlled, { onChange: () => {} })));
    const trigger = screen.getByRole("combobox", { name: "Worktree" });
    expect(trigger.textContent).toContain("native-git");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const listbox = screen.getByRole("listbox", { name: "Worktree" });
    const labels = [...listbox.querySelectorAll('[aria-disabled="true"]')].map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["Main worktree", "Worktrees"]);
    const current = listbox.querySelector('[aria-current="true"]');
    expect(current?.getAttribute("data-worktree-id")).toBe("wt-1");
    expect(current?.textContent).toContain("Current");
    // A keyboard open lands the cursor on the chosen worktree.
    expect(current?.getAttribute("aria-selected")).toBe("true");
  });

  it("filters by name, branch and path and picks with Enter", () => {
    const onChange = vi.fn();
    render(withTooltips(createElement(Controlled, { onChange })));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Worktree" }), { key: "ArrowDown" });
    const search = screen.getByRole("combobox", { name: "Search worktrees" });
    fireEvent.change(search, { target: { value: "bugfix" } });
    const options = screen.getByRole("listbox").querySelectorAll("[data-worktree-id]");
    expect(options).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("wt-2");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Worktree" }).textContent).toContain("fix-crash");
  });

  it("steps the cursor with the arrows and picks with a click", () => {
    const onChange = vi.fn();
    render(withTooltips(createElement(Controlled, { onChange })));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Worktree" }), { key: "ArrowDown" });
    const search = screen.getByRole("combobox", { name: "Search worktrees" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const active = search.getAttribute("aria-activedescendant");
    expect(document.getElementById(active ?? "")?.getAttribute("data-worktree-id")).toBe("wt-2");
    const main = screen.getByRole("listbox").querySelector('[data-worktree-id="main"]');
    fireEvent.click(main!);
    expect(onChange).toHaveBeenCalledWith("main");
  });

  it("uses the author's groups, says when nothing matches, and can start open", () => {
    const grouped = WORKTREES.map((worktree, index) => ({
      ...worktree,
      group: index === 0 ? "Pinned" : "Recent",
    }));
    render(
      withTooltips(
        createElement(kit.WorktreePicker, {
          worktrees: grouped,
          defaultOpen: true,
          placeholder: "Pick one",
        })
      )
    );
    expect(screen.getByRole("combobox", { name: "Worktree" }).textContent).toContain("Pick one");
    const labels = [...screen.getByRole("listbox").querySelectorAll('[aria-disabled="true"]')].map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["Pinned", "Recent"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Search worktrees" }), {
      target: { value: "zzz" },
    });
    expect(screen.getByRole("status").textContent).toBe("No matching worktrees");
  });

  it("drops worktrees without an id or repeating one", () => {
    render(
      withTooltips(
        untyped("WorktreePicker", {
          worktrees: [{ id: "a", name: "A" }, { name: "no id" }, { id: "a", name: "dup" }, 7],
          defaultOpen: true,
        })
      )
    );
    expect(screen.getByRole("listbox").querySelectorAll("[data-worktree-id]")).toHaveLength(1);
  });
});

const COMMITS: Commit[] = [
  {
    sha: "0123456789abcdef0123456789abcdef01234567",
    subject: "Add native git components",
    author: { name: "Ada", email: "ada@example.com" },
    date: Date.now() - 60_000,
    refs: [
      { name: "feature/native-git", kind: "head" },
      { name: "v1.2.0", kind: "tag" },
      { name: "origin/x", kind: "remote" },
    ],
    additions: 120,
    deletions: 8,
    unpushed: true,
  },
  {
    sha: "fedcba9876543210fedcba9876543210fedcba98",
    subject: "Fix the build",
    date: "2026-09-01T10:00:00Z",
  },
];

describe("CommitRow and CommitList", () => {
  it("draws subject, author, age, refs, churn and a short hash", () => {
    render(
      withTooltips(createElement(kit.CommitRow, { commit: COMMITS[0]!, "data-testid": "row" }))
    );
    const row = screen.getByTestId("row");
    expect(row.textContent).toContain("Add native git components");
    expect(row.textContent).toContain("Not pushed");
    expect(row.textContent).toContain("Ada");
    expect(row.textContent).toContain("+120");
    expect(row.textContent).toContain("-8");
    expect(row.querySelector('[data-ref-kind="head"]')?.getAttribute("aria-label")).toBe(
      "Checked out feature/native-git"
    );
    // Two refs drawn; the third folds into "+1", named in full.
    expect(row.querySelectorAll("[data-ref-kind]")).toHaveLength(2);
    expect(screen.getByLabelText("1 more: origin/x").textContent).toBe("+1");
    expect(row.querySelector("time")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy hash 0123456" })).toBeTruthy();
  });

  it("copies the full hash", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(withTooltips(createElement(kit.CommitRow, { commit: COMMITS[1]!, shaLength: 10 })));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy hash fedcba9876" }));
    });
    expect(writeText).toHaveBeenCalledWith(COMMITS[1]!.sha);
  });

  it("makes the subject a button when the row activates, and draws a skeleton on request", () => {
    const onActivate = vi.fn();
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.CommitRow, { commit: COMMITS[1]!, onActivate }),
          createElement(kit.CommitRow, { skeleton: true, "data-testid": "sk" }),
          untyped("CommitRow", { commit: { subject: "no sha" }, "data-testid": "bad" })
        )
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Fix the build" }));
    expect(onActivate).toHaveBeenCalledWith(COMMITS[1]);
    expect(screen.getByTestId("sk").querySelector("[data-kit-commit-skeleton]")).not.toBeNull();
    expect(screen.queryByTestId("bad")).toBeNull();
  });

  it("lists commits with skeleton rows while loading and steps rows with the arrows", () => {
    const onActivate = vi.fn();
    render(
      withTooltips(
        createElement(kit.CommitList, {
          commits: COMMITS,
          loading: 1,
          onActivate,
          "aria-label": "Commits",
        })
      )
    );
    const list = screen.getByRole("list", { name: "Commits" });
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(list.querySelectorAll("[data-kit-commit-skeleton]")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Loading commits");
    const first = screen.getByRole("button", { name: "Add native git components" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fix the build" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("shows the empty content when there is nothing", () => {
    render(
      createElement(kit.CommitList, { commits: [], empty: "No commits yet", "data-testid": "e" })
    );
    expect(screen.getByTestId("e").textContent).toBe("No commits yet");
  });
});

describe("ForgeStateBadge", () => {
  it("gives every state its own shape and colour, never colour alone", () => {
    const states = ["open", "draft", "merged", "closed"] as const;
    const looks = states.map((state) => forgeStateLook("pr", state));
    expect(new Set(looks.map((look) => look.Glyph)).size).toBe(4);
    expect(new Set(looks.map((look) => look.tone)).size).toBe(4);
    expect(forgeStateLook("issue", "open").Glyph).not.toBe(forgeStateLook("issue", "closed").Glyph);
  });

  it("draws an issue in any state but open as closed", () => {
    render(
      createElement(kit.ForgeStateBadge, { kind: "issue", state: "merged", "data-testid": "i" })
    );
    const badge = screen.getByTestId("i");
    expect(badge.getAttribute("aria-label")).toBe("Closed issue");
    expect(badge.getAttribute("data-forge-state")).toBe("closed");
  });

  it("is a named glyph by default and a worded badge on request", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.ForgeStateBadge, { state: "draft", "data-testid": "g" }),
        createElement(kit.ForgeStateBadge, {
          kind: "issue",
          state: "closed",
          variant: "badge",
          "data-testid": "b",
        }),
        untyped("ForgeStateBadge", { state: "exploded", "data-testid": "x" })
      )
    );
    expect(screen.getByTestId("g").getAttribute("aria-label")).toBe("Draft pull request");
    expect(screen.getByTestId("b").textContent).toBe("Closed");
    expect(screen.queryByTestId("x")).toBeNull();
  });
});

describe("IssueRow and PullRequestRow", () => {
  it("draws an issue's state, number, title, author, comments, labels and assignees", () => {
    render(
      withTooltips(
        createElement(kit.IssueRow, {
          number: 412,
          title: "Crash when a worktree is deleted",
          state: "open",
          author: { name: "grace" },
          commentCount: 3,
          updatedAt: Date.now() - 3_600_000,
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "p1", color: "#fbca04" },
            { name: "ui" },
          ],
          assignees: [{ name: "ada" }, { name: "linus" }],
          "data-testid": "row",
        })
      )
    );
    const row = screen.getByTestId("row");
    expect(row.getAttribute("data-forge-state")).toBe("open");
    expect(screen.getByRole("img", { name: "Open issue" })).toBeTruthy();
    expect(row.textContent).toContain("#412");
    expect(row.textContent).toContain("grace");
    expect(screen.getByRole("img", { name: "3 comments" })).toBeTruthy();
    // The github row's run: the first label, then a count for the rest.
    expect(screen.getByRole("img", { name: "Labels: bug, p1, ui" }).textContent).toBe("bug+2");
    expect(row.textContent).toContain("Crash when a worktree is deleted");
  });

  it("opens the forge url from the title, or hands the press to onOpen", () => {
    const onOpen = vi.fn();
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.IssueRow, {
            number: 1,
            title: "By url",
            state: "closed",
            url: "https://forge.example/issues/1",
          }),
          createElement(kit.IssueRow, { number: 2, title: "By handler", state: "open", onOpen }),
          createElement(kit.IssueRow, {
            number: 3,
            title: "Bad url",
            state: "open",
            url: "javascript:alert(1)",
          })
        )
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "By url" }));
    expect(dispatch).toHaveBeenCalledWith(
      "browser.openExternal",
      { url: "https://forge.example/issues/1" },
      { source: "user" }
    );
    fireEvent.click(screen.getByRole("button", { name: "By handler" }));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Bad url" })).toBeNull();
  });

  it("shows a pull request's checks, review and head branch while it is open", () => {
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.PullRequestRow, {
            number: 77,
            title: "Draft work",
            state: "draft",
            ci: "failure",
            review: "changes_requested",
            headRef: "feature/x",
            baseRef: "develop",
            "data-testid": "open",
          }),
          createElement(kit.PullRequestRow, {
            number: 78,
            title: "Merged work",
            state: "merged",
            ci: "failure",
            review: "approved",
            "data-testid": "merged",
          })
        )
      )
    );
    expect(screen.getByRole("img", { name: "Draft pull request" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Checks failing" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Review: Changes requested" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Merges feature/x into develop" })).toBeTruthy();
    const merged = screen.getByTestId("merged");
    expect(merged.querySelector('[data-rail-slot="ci"]')).toBeNull();
    expect(merged.textContent).not.toContain("Approved");
  });

  it("lets a merge conflict take the checks slot", () => {
    expect(ciLook("success", true)?.label).toBe("Merge conflicts");
    expect(ciLook("pending", false)?.kind).toBe("dot");
    expect(ciLook("neutral", false)).toBeNull();
    expect(ciLook(undefined, false)).toBeNull();
  });
});

const CHECKS: CheckRun[] = [
  { name: "lint", status: "success", workflow: "CI", durationMs: 42_000 },
  {
    name: "test (shard 1)",
    status: "failure",
    workflow: "CI",
    required: true,
    detailsUrl: "https://ci.example/1",
  },
  { name: "test (shard 2)", status: "running", workflow: "CI", startedAt: Date.now() - 5_000 },
  { name: "deploy preview", status: "queued", workflow: "Deploy" },
  { name: "docs", status: "skipped", workflow: "Deploy" },
  { name: "test (shard 1)", status: "failure", workflow: "CI", detailsUrl: "https://ci.example/2" },
];

describe("ChecksList", () => {
  it("summarises in the order a reader acts on", () => {
    expect(
      checksSummary(["success", "failure", "running", "success", "skipped", "timed_out"])
    ).toBe("2 failing, 1 running, 2 passing, 1 skipped");
    expect(checksSummary([])).toBe("");
  });

  it("groups by workflow, failures first, under the summary", () => {
    render(
      withTooltips(
        createElement(kit.ChecksList, { checks: CHECKS, title: "Checks", "aria-label": "CI" })
      )
    );
    const section = screen.getByRole("region", { name: "CI" });
    expect(section.querySelector("[data-kit-checks-summary]")?.textContent).toBe(
      "2 failing, 1 running, 1 queued, 1 passing, 1 skipped"
    );
    const groups = [...section.querySelectorAll("[data-kit-checks-group]")].map((g) =>
      g.getAttribute("data-kit-checks-group")
    );
    expect(groups).toEqual(["CI", "Deploy"]);
    const ci = screen.getByRole("list", { name: "CI" });
    const order = [...ci.querySelectorAll("li")].map((li) => li.getAttribute("data-check-status"));
    // While something needs a look, the passes wait behind a count.
    expect(order).toEqual(["failure", "failure", "running"]);
    expect(ci.textContent).toContain("Failed · Required");
    const fold = screen.getByRole("button", { name: "Show 1 passing" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    const opened = [...screen.getByRole("list", { name: "CI" }).querySelectorAll("li")];
    expect(opened.map((li) => li.getAttribute("data-check-status"))).toEqual([
      "failure",
      "failure",
      "running",
      "success",
    ]);
    expect(opened[3]?.textContent).toContain("42s");
    expect(screen.getByRole("button", { name: "Hide 1 passing" })).toBeTruthy();
  });

  it("tells repeated names apart on the details buttons and opens the details url", () => {
    render(withTooltips(createElement(kit.ChecksList, { checks: CHECKS })));
    const second = screen.getByRole("button", {
      name: "Open details for CI / test (shard 1), 2 of 2",
    });
    fireEvent.click(second);
    expect(dispatch).toHaveBeenCalledWith(
      "browser.openExternal",
      { url: "https://ci.example/2" },
      { source: "user" }
    );
    // No url, no button.
    expect(screen.queryByRole("button", { name: /lint/ })).toBeNull();
  });

  it("hands details to onOpenDetails, drops bad checks, and shows empty content", () => {
    const onOpenDetails = vi.fn();
    const { rerender } = render(
      withTooltips(
        untyped("ChecksList", {
          checks: [
            { name: "x", status: "bogus" },
            { name: "y", status: "success" },
          ],
          onOpenDetails,
        })
      )
    );
    expect(document.querySelectorAll("[data-check-status]")).toHaveLength(1);
    expect(screen.queryByText("x")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open details for y" }));
    expect(onOpenDetails).toHaveBeenCalledWith({ name: "y", status: "success" });
    rerender(withTooltips(createElement(kit.ChecksList, { checks: [], empty: "No checks yet" })));
    expect(screen.getByText("No checks yet")).toBeTruthy();
  });
});

describe("PortLink and DevServerStatus", () => {
  it("accepts loopback addresses only", () => {
    expect(portLinkUrl("http://localhost:5173/app", undefined)).toBe("http://localhost:5173/app");
    expect(portLinkUrl(undefined, 3000)).toBe("http://localhost:3000/");
    expect(portLinkUrl("https://example.com", undefined)).toBeNull();
    expect(portLinkUrl(undefined, 70_000)).toBeNull();
    expect(portLinkUrl("file:///etc/passwd", undefined)).toBeNull();
  });

  it("opens in a browser panel by default and in the system browser on request", () => {
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.PortLink, { port: 5173 }),
          createElement(kit.PortLink, { url: "http://127.0.0.1:8080/docs", target: "external" })
        )
      )
    );
    const panel = screen.getByRole("link", { name: "Open localhost:5173 in a browser panel" });
    expect(panel.textContent).toBe("localhost:5173");
    fireEvent.click(panel);
    expect(dispatch).toHaveBeenCalledWith(
      "browser.openUrl",
      { url: "http://localhost:5173/" },
      { source: "user" }
    );
    fireEvent.click(screen.getByRole("link", { name: "Open 127.0.0.1:8080/docs in your browser" }));
    expect(dispatch).toHaveBeenLastCalledWith(
      "browser.openExternal",
      { url: "http://127.0.0.1:8080/docs" },
      { source: "user" }
    );
    expect(screen.getByRole("button", { name: "Copy localhost:5173" })).toBeTruthy();
  });

  it("draws a non-loopback address as text", () => {
    render(createElement(kit.PortLink, { url: "https://evil.example", "data-testid": "p" }));
    expect(screen.getByTestId("p").tagName).toBe("SPAN");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the state, the address while running and the reason it crashed", () => {
    const { rerender } = render(
      withTooltips(
        createElement(kit.DevServerStatus, {
          status: "running",
          name: "Vite",
          port: 5173,
          "data-testid": "d",
        })
      )
    );
    expect(screen.getByRole("status").textContent).toBe("ViteRunning");
    expect(screen.getByRole("link", { name: /localhost:5173/ })).toBeTruthy();
    rerender(
      withTooltips(
        createElement(kit.DevServerStatus, {
          status: "crashed",
          port: 5173,
          error: "EADDRINUSE: port 5173 is taken",
          "data-testid": "d",
        })
      )
    );
    expect(screen.getByRole("status").textContent).toBe("Dev serverCrashed");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("d").textContent).toContain("EADDRINUSE");
    rerender(withTooltips(untyped("DevServerStatus", { status: "nonsense", "data-testid": "d" })));
    expect(screen.getByTestId("d").getAttribute("data-dev-server-status")).toBe("stopped");
  });
});

describe("review regressions", () => {
  it("reopens a controlled picker with a fresh search", () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", onClick: () => setOpen((o) => !o) }, "toggle"),
        createElement(kit.WorktreePicker, { worktrees: WORKTREES, open, onOpenChange: setOpen })
      );
    }
    render(withTooltips(createElement(Host)));
    fireEvent.change(screen.getByRole("combobox", { name: "Search worktrees" }), {
      target: { value: "zzz" },
    });
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(
      (screen.getByRole("combobox", { name: "Search worktrees" }) as HTMLInputElement).value
    ).toBe("");
    expect(screen.getByRole("listbox").querySelectorAll("[data-worktree-id]")).toHaveLength(3);
  });

  it("leaves modified Enter to whatever encloses the picker", () => {
    const onValueChange = vi.fn();
    const onKeyDown = vi.fn();
    render(
      withTooltips(
        createElement(
          "div",
          { onKeyDown },
          createElement(kit.WorktreePicker, {
            worktrees: WORKTREES,
            defaultOpen: true,
            onValueChange,
          })
        )
      )
    );
    const search = screen.getByRole("combobox", { name: "Search worktrees" });
    fireEvent.change(search, { target: { value: "fix" } });
    fireEvent.keyDown(search, { key: "Enter", metaKey: true });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onKeyDown).toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("wt-2", WORKTREES[2]);
  });

  it("keeps a worktree id that looks like a heading apart from the heading", () => {
    render(
      withTooltips(
        createElement(kit.WorktreePicker, {
          worktrees: [
            { id: "main", name: "main", isMainWorktree: true },
            { id: "group:Worktrees", name: "tricky" },
            { id: "x", name: "x" },
          ],
          defaultOpen: true,
        })
      )
    );
    expect(screen.getByRole("listbox").querySelectorAll("[data-worktree-id]")).toHaveLength(3);
  });

  it("keeps repeated hashes, ids and label names as separate rows", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.CommitList, {
            commits: [
              { sha: "a", subject: "one" },
              { sha: "a", subject: "two" },
              { sha: "a", subject: "three" },
            ],
            "aria-label": "Commits",
          }),
          createElement(kit.ChecksList, {
            checks: [
              { id: "at:1", name: "first", status: "success" },
              { name: "second", status: "success" },
              { id: "dup", name: "third", status: "failure" },
              { id: "dup", name: "fourth", status: "failure" },
            ],
          }),
          createElement(kit.IssueRow, {
            number: 1,
            title: "t",
            state: "open",
            labels: [{ name: "bug" }, { name: "bug" }],
          })
        )
      )
    );
    expect(screen.getByRole("list", { name: "Commits" }).querySelectorAll("li")).toHaveLength(3);
    // Two failures, and the two passes folded behind their count.
    expect(document.querySelectorAll("[data-check-status]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show 2 passing" })).toBeTruthy();
    const keyWarnings = errors.mock.calls.filter((call) => String(call[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
    errors.mockRestore();
  });

  it("draws three skeletons for loading with no commits and drops the empty content", () => {
    const { rerender } = render(
      createElement(kit.CommitList, {
        commits: [],
        loading: true,
        empty: "No commits yet",
        "aria-label": "Commits",
      })
    );
    const list = screen.getByRole("list", { name: "Commits" });
    expect(list.querySelectorAll("[data-kit-commit-skeleton]")).toHaveLength(3);
    expect(screen.queryByText("No commits yet")).toBeNull();
    rerender(
      withTooltips(
        createElement(kit.CommitList, {
          commits: COMMITS,
          loading: false,
          "aria-label": "Commits",
        })
      )
    );
    expect(screen.getByRole("list", { name: "Commits" }).getAttribute("aria-busy")).toBeNull();
  });

  it("treats a Date-shaped object without a date as no date", () => {
    // A Date to `instanceof`, with none of a Date's internal state.
    const fake: Date = Object.create(Date.prototype, {});
    render(
      withTooltips(
        createElement(kit.CommitRow, {
          commit: { sha: "abc1234", subject: "odd", date: fake },
          "data-testid": "row",
        })
      )
    );
    expect(screen.getByTestId("row").querySelector("time")).toBeNull();
  });

  it("refuses loopback addresses that carry credentials, and links IPv6 loopback", () => {
    expect(portLinkUrl("http://user:pw@localhost:3000/", undefined)).toBeNull();
    expect(portLinkUrl("http://[::1]:3000/", undefined)).toBe("http://[::1]:3000/");
    expect(portLinkUrl("http://localhost:4000/", 5000)).toBe("http://localhost:4000/");
  });

  it("puts required failures before optional ones and the worst workflow first", () => {
    render(
      withTooltips(
        createElement(kit.ChecksList, {
          checks: [
            { name: "deploy", status: "success", workflow: "Deploy" },
            { name: "optional", status: "failure", workflow: "CI" },
            { name: "required", status: "failure", workflow: "CI", required: true },
          ],
        })
      )
    );
    const groups = [...document.querySelectorAll("[data-kit-checks-group]")].map((g) =>
      g.getAttribute("data-kit-checks-group")
    );
    expect(groups).toEqual(["CI", "Deploy"]);
    const names = [...screen.getByRole("list", { name: "CI" }).querySelectorAll("li")].map(
      (li) => li.querySelector(".font-medium")?.textContent
    );
    expect(names).toEqual(["required", "optional"]);
  });

  it("counts a running check's time live and prefers an explicit duration", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "setTimeout"] });
    try {
      const start = Date.now();
      render(
        withTooltips(
          createElement(kit.ChecksList, {
            checks: [
              { name: "live", status: "running", startedAt: start - 5_000 },
              { name: "fixed", status: "running", startedAt: start - 5_000, durationMs: 90_000 },
            ],
          })
        )
      );
      // The shared clock ticks on its own second, so read the live age as a
      // number and watch it move rather than pin one rendering of it.
      const seconds = () =>
        Number(
          /(\d+)s$/.exec(
            document.querySelectorAll("[data-check-status]")[0]?.textContent ?? ""
          )?.[1]
        );
      const before = seconds();
      expect(before).toBeGreaterThanOrEqual(4);
      expect(document.querySelectorAll("[data-check-status]")[1]?.textContent).toContain("1m");
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(seconds()).toBeGreaterThanOrEqual(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a merge conflict in the pull request row's checks slot", () => {
    render(
      withTooltips(
        createElement(kit.PullRequestRow, {
          number: 9,
          title: "Conflicted",
          state: "open",
          ci: "success",
          mergeConflict: true,
        })
      )
    );
    expect(screen.getByRole("img", { name: "Merge conflicts" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Checks passing" })).toBeNull();
  });

  it("logs rather than swallows an action the host refuses", async () => {
    dispatch.mockResolvedValueOnce({ ok: false, error: { message: "nope" } });
    logError.mockClear();
    render(withTooltips(createElement(kit.PortLink, { port: 5173 })));
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: /localhost:5173/ }));
    });
    expect(logError).toHaveBeenCalledWith("[plugin-kit] browser.openUrl failed", {
      message: "nope",
    });
  });
});

describe("round 1 design fixes", () => {
  it("shows every check when nothing needs a look", () => {
    render(
      withTooltips(
        createElement(kit.ChecksList, {
          checks: [
            { name: "a", status: "success" },
            { name: "b", status: "skipped" },
          ],
        })
      )
    );
    expect(document.querySelectorAll("[data-check-status]")).toHaveLength(2);
    expect(document.querySelector("[data-kit-checks-fold]")).toBeNull();
  });

  it("gives a commit list one tab stop and moves it with the arrows", () => {
    render(
      withTooltips(
        createElement(kit.CommitList, {
          commits: COMMITS,
          onActivate: () => {},
          "aria-label": "Commits",
        })
      )
    );
    const list = screen.getByRole("list", { name: "Commits" });
    const stops = [...list.querySelectorAll<HTMLElement>("button")].filter((b) => b.tabIndex === 0);
    expect(stops).toHaveLength(1);
    const first = screen.getByRole("button", { name: "Add native git components" });
    expect(stops[0]).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const sha = screen.getByRole("button", { name: "Copy hash 0123456" });
    expect(document.activeElement).toBe(sha);
    fireEvent.keyDown(sha, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy hash fedcba9" }));
    expect(
      [...list.querySelectorAll<HTMLElement>("button")].filter((b) => b.tabIndex === 0)
    ).toEqual([document.activeElement]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("shows an absolute path inside the root relative to it", () => {
    render(
      withTooltips(
        createElement(kit.FileLink, {
          path: "/repo/src/a.ts",
          rootPath: "/repo",
          "data-testid": "link",
        })
      )
    );
    expect(screen.getByTestId("link").textContent).toBe("src/a.ts");
  });

  it("marks the selected row current, and draws one assignee with a count", () => {
    render(
      withTooltips(
        createElement(kit.IssueRow, {
          number: 3,
          title: "Current one",
          state: "open",
          onOpen: () => {},
          selected: true,
          assignees: [{ name: "ada" }, { name: "grace" }, { name: "linus" }],
        })
      )
    );
    expect(screen.getByRole("button", { name: "Current one" }).getAttribute("aria-current")).toBe(
      "true"
    );
    const slot = screen.getByRole("img", { name: "Assigned to ada, grace, linus" });
    expect(slot.textContent).toContain("+2");
  });
});

describe("round 2 design fixes", () => {
  it("keeps each metadata item's separator inside it, so a dropped item takes its dot", () => {
    render(
      withTooltips(
        createElement(kit.PullRequestRow, {
          number: 7,
          title: "t",
          state: "open",
          author: { name: "ada" },
          updatedAt: Date.now() - 60_000,
          commentCount: 2,
          headRef: "feature/x",
          labels: [{ name: "bug", color: "#d73a4a" }],
          review: "approved",
          "data-testid": "row",
        })
      )
    );
    const meta = screen.getByTestId("row").querySelector("[data-forge-row-meta]")!;
    const items = [...meta.children];
    expect(items.length).toBe(7);
    expect(items[0]?.textContent).toBe("#7");
    for (const item of items.slice(1)) expect(item.textContent?.startsWith("·")).toBe(true);
  });

  it("holds every check's duration in one column when any row has a details button", () => {
    render(
      withTooltips(
        createElement(kit.ChecksList, {
          checks: [
            { name: "a", status: "failure", durationMs: 1000, detailsUrl: "https://ci.example/a" },
            { name: "b", status: "running", durationMs: 2000 },
          ],
        })
      )
    );
    const rows = [...document.querySelectorAll("[data-check-status]")];
    // Same child count: the row without a button keeps an empty slot.
    expect(rows[0]?.children.length).toBe(rows[1]?.children.length);
  });
});
