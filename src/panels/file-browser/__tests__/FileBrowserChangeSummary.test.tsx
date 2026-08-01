// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@shared/types/git";
import type { WorkingTreeFileChange } from "@/lib/workingTreeDiff";
import { FileBrowserChangeSummary } from "../FileBrowserChangeSummary";

function change(
  relativePath: string,
  status: GitStatus,
  churn: { insertions?: number; deletions?: number } = {}
): WorkingTreeFileChange {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    status,
    insertions: churn.insertions ?? null,
    deletions: churn.deletions ?? null,
  };
}

function renderSummary(changes: WorkingTreeFileChange[], onSelect = vi.fn()) {
  render(<FileBrowserChangeSummary changes={changes} onSelect={onSelect} />);
  return onSelect;
}

describe("FileBrowserChangeSummary", () => {
  it("renders the changes in the order it is given", () => {
    renderSummary([
      change("src/big.ts", "modified"),
      change("src/small.ts", "modified"),
      change("docs/notes.md", "added"),
    ]);

    const rendered = screen.getAllByRole("button").map((button) => button.getAttribute("title"));

    expect(rendered).toEqual(["src/big.ts", "src/small.ts", "docs/notes.md"]);
  });

  it("hands the worktree-relative path to the selection callback", () => {
    const onSelect = renderSummary([change("src/app.ts", "modified")]);

    screen.getByRole("button", { name: /src\/app\.ts/ }).click();

    expect(onSelect).toHaveBeenCalledWith("src/app.ts");
  });

  it("names each row by what activating it does, plus the status", () => {
    renderSummary([change("src/app.ts", "modified")]);

    expect(screen.getByRole("button", { name: "Read src/app.ts, Modified" })).toBeTruthy();
  });

  it("distinguishes statuses in the accessible name, not by colour alone", () => {
    renderSummary([change("src/new.ts", "added"), change("src/old.ts", "modified")]);

    expect(screen.getByRole("button", { name: /Added/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Modified/ })).toBeTruthy();
  });

  it("lists a deleted file but refuses to open it", () => {
    const onSelect = renderSummary([change("src/gone.ts", "deleted")]);
    const row = screen.getByRole("button", { name: /src\/gone\.ts/ });

    expect(row.getAttribute("aria-disabled")).toBe("true");

    row.click();

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps a deleted row reachable by keyboard so its reason is discoverable", () => {
    renderSummary([change("src/gone.ts", "deleted")]);
    const row = screen.getByRole("button", { name: /deleted file isn't available to read/i });

    // aria-disabled, not `disabled` — a disabled button drops out of the tab
    // order and the explanation becomes unreachable.
    expect(row.hasAttribute("disabled")).toBe(false);
  });

  it("still opens readable siblings of a deleted file", () => {
    const onSelect = renderSummary([
      change("src/gone.ts", "deleted"),
      change("src/kept.ts", "modified"),
    ]);

    screen.getByRole("button", { name: /Read src\/kept\.ts/ }).click();

    expect(onSelect).toHaveBeenCalledWith("src/kept.ts");
  });

  it("shows churn only for the sides that actually moved", () => {
    renderSummary([
      change("src/grew.ts", "modified", { insertions: 12, deletions: 0 }),
      change("src/shrank.ts", "modified", { insertions: 0, deletions: 7 }),
    ]);

    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("-7")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
    expect(screen.queryByText("-0")).toBeNull();
  });

  it("splits a nested path so the filename stays readable beside its folder", () => {
    renderSummary([change("src/panels/app.ts", "modified")]);

    expect(screen.getByText("src/panels/")).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
  });

  it("renders a root-level file without an empty directory fragment", () => {
    renderSummary([change("README.md", "modified")]);

    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.queryByText("/")).toBeNull();
  });

  it("keeps rows distinct when one path appears under two statuses", () => {
    // Staged and unstaged are separate rows for the same file; a path-only key
    // would collapse them and React would warn about duplicates.
    renderSummary([change("src/app.ts", "modified"), change("src/app.ts", "added")]);

    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
