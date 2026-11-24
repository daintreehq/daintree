/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import { BaseBranchFileRow } from "../BaseBranchFileRow";

afterEach(cleanup);

function renderRow(file: CrossWorktreeFile) {
  render(<BaseBranchFileRow file={file} rowIndex={0} onClick={vi.fn()} />);
}

describe("BaseBranchFileRow accessible name", () => {
  it.each([
    ["A", "Added"],
    ["D", "Deleted"],
    ["R", "Renamed"],
    ["M", "Modified"],
    ["T", "Type changed"],
  ])("announces %s as %s with the path", (status, word) => {
    renderRow({ path: "src/lib/thing.ts", status, insertions: 1, deletions: 0 });
    expect(screen.getByRole("button", { name: `${word}: src/lib/thing.ts` })).toBeTruthy();
  });

  it("falls back to the raw status for an unknown code", () => {
    renderRow({ path: "a.ts", status: "X", insertions: null, deletions: null });
    expect(screen.getByRole("button", { name: "X: a.ts" })).toBeTruthy();
  });
});
