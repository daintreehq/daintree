/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import type { FileChangeDetail } from "../../../types";

vi.mock("../FileDiffModal", () => ({
  FileDiffModal: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { FileChangeList } from "../FileChangeList";

const ROOT = "/repo";

function file(path: string, status: FileChangeDetail["status"] = "modified"): FileChangeDetail {
  return { path, status, insertions: 1, deletions: 0 };
}

function newRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-recency-new="true"]')).map(
    (el) => {
      const base = el.querySelector(".truncate.min-w-0.font-medium")?.textContent ?? "";
      return base;
    }
  );
}

describe("FileChangeList — row-recency cue (#6544)", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not flash any row on first render (panel-open seeding)", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts"), file("c.ts")]} rootPath={ROOT} />
    );
    expect(newRows(container)).toEqual([]);
  });

  it("marks only freshly arrived rows after a rerender", () => {
    const initial = [file("a.ts"), file("b.ts")];
    const { container, rerender } = render(<FileChangeList changes={initial} rootPath={ROOT} />);
    expect(newRows(container)).toEqual([]);

    act(() => {
      rerender(
        <FileChangeList changes={[...initial, file("c.ts"), file("d.ts")]} rootPath={ROOT} />
      );
    });

    expect(newRows(container).sort()).toEqual(["c.ts", "d.ts"]);
  });

  it("does not re-mark rows on a stable rerender", () => {
    const same = [file("a.ts"), file("b.ts")];
    const { container, rerender } = render(<FileChangeList changes={same} rootPath={ROOT} />);

    act(() => {
      rerender(<FileChangeList changes={[...same]} rootPath={ROOT} />);
    });

    expect(newRows(container)).toEqual([]);
  });

  it("treats a status change for the same path as a new row", () => {
    const initial = [file("a.ts", "modified")];
    const { container, rerender } = render(<FileChangeList changes={initial} rootPath={ROOT} />);

    act(() => {
      rerender(<FileChangeList changes={[file("a.ts", "deleted")]} rootPath={ROOT} />);
    });

    expect(newRows(container)).toEqual(["a.ts"]);
  });

  it("default maxVisible is 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`file-${i}.ts`));
    const { container } = render(<FileChangeList changes={many} rootPath={ROOT} />);
    const rows = container.querySelectorAll<HTMLElement>(".group\\/filerow");
    expect(rows.length).toBe(8);
  });

  it("explicit maxVisible override wins over the new default", () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`file-${i}.ts`));
    const { container } = render(<FileChangeList changes={many} rootPath={ROOT} maxVisible={3} />);
    const rows = container.querySelectorAll<HTMLElement>(".group\\/filerow");
    expect(rows.length).toBe(3);
  });

  it("applies the file-change-row-new class only to rows that are new", () => {
    const initial = [file("a.ts"), file("b.ts")];
    const { container, rerender } = render(<FileChangeList changes={initial} rootPath={ROOT} />);

    act(() => {
      rerender(<FileChangeList changes={[...initial, file("c.ts")]} rootPath={ROOT} />);
    });

    const newClassRows = container.querySelectorAll<HTMLElement>(".file-change-row-new");
    expect(newClassRows.length).toBe(1);
    expect(newClassRows[0].textContent).toContain("c.ts");
  });
});
