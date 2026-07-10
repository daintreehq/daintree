/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import type { FileChangeDetail } from "../../../types";

const { capturedModalProps } = vi.hoisted(() => ({
  capturedModalProps: {
    isOpen: false as boolean,
    filePath: "" as string,
    restoreFocusTo: undefined as unknown,
    currentFileIndex: undefined as number | undefined,
    totalFileCount: undefined as number | undefined,
    onNavigateFile: undefined as ((delta: -1 | 1) => void) | undefined,
    onClose: undefined as (() => void) | undefined,
  },
}));

vi.mock("../FileDiffModal", () => ({
  FileDiffModal: (props: {
    isOpen: boolean;
    filePath: string;
    restoreFocusTo?: unknown;
    currentFileIndex?: number;
    totalFileCount?: number;
    onNavigateFile?: (delta: -1 | 1) => void;
    onClose: () => void;
  }) => {
    capturedModalProps.isOpen = props.isOpen;
    capturedModalProps.filePath = props.filePath;
    capturedModalProps.restoreFocusTo = props.restoreFocusTo;
    capturedModalProps.currentFileIndex = props.currentFileIndex;
    capturedModalProps.totalFileCount = props.totalFileCount;
    capturedModalProps.onNavigateFile = props.onNavigateFile;
    capturedModalProps.onClose = props.onClose;
    return null;
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { FileChangeList, type FileChangeListHandle } from "../FileChangeList";

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
    expect(newClassRows[0]!.textContent).toContain("c.ts");
  });

  it("clears the cue from previously-new rows on the next update", () => {
    const initial = [file("a.ts"), file("b.ts")];
    const { container, rerender } = render(<FileChangeList changes={initial} rootPath={ROOT} />);

    // Round 1: c.ts arrives
    act(() => {
      rerender(<FileChangeList changes={[...initial, file("c.ts")]} rootPath={ROOT} />);
    });
    expect(newRows(container).sort()).toEqual(["c.ts"]);

    // Round 2: d.ts arrives — c.ts must no longer be marked new
    act(() => {
      rerender(
        <FileChangeList changes={[...initial, file("c.ts"), file("d.ts")]} rootPath={ROOT} />
      );
    });
    expect(newRows(container).sort()).toEqual(["d.ts"]);
  });

  it("marks new rows correctly under groupByFolder", () => {
    const initial = [file("src/a.ts"), file("src/b.ts")];
    const { container, rerender } = render(
      <FileChangeList changes={initial} rootPath={ROOT} groupByFolder />
    );
    expect(newRows(container)).toEqual([]);

    act(() => {
      rerender(
        <FileChangeList
          changes={[...initial, file("src/c.ts"), file("test/d.ts")]}
          rootPath={ROOT}
          groupByFolder
        />
      );
    });

    expect(newRows(container).sort()).toEqual(["c.ts", "d.ts"]);
  });

  it("does not cue a file that is merely promoted into the visible window by sort changes", () => {
    // c.ts starts hidden behind maxVisible=2 (lower churn). Then a churn bump
    // promotes it into view. Identity already known — must NOT flash.
    const a = { ...file("a.ts"), insertions: 10 };
    const b = { ...file("b.ts"), insertions: 5 };
    const c = { ...file("c.ts"), insertions: 1 };
    const { container, rerender } = render(
      <FileChangeList changes={[a, b, c]} rootPath={ROOT} maxVisible={2} />
    );
    expect(newRows(container)).toEqual([]);

    // Bump c's churn so it sorts to the top (now visible). a and b drop down.
    const cBumped = { ...c, insertions: 100 };
    act(() => {
      rerender(<FileChangeList changes={[a, b, cBumped]} rootPath={ROOT} maxVisible={2} />);
    });

    expect(newRows(container)).toEqual([]);
  });
});

describe("FileChangeList — stale state (#8069)", () => {
  afterEach(() => {
    cleanup();
  });

  function scroll(container: HTMLElement): HTMLElement {
    const el = container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!el) throw new Error("scroll container not found");
    return el;
  }

  it("does not apply stale styling when isStale is absent", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts")]} rootPath={ROOT} />
    );
    const el = scroll(container);
    expect(el.classList.contains("surface-stale")).toBe(false);
    expect(el.getAttribute("aria-busy")).toBeNull();
  });

  it("applies surface-stale and aria-busy in the flat branch when isStale", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts")]} rootPath={ROOT} isStale />
    );
    const el = scroll(container);
    expect(el.classList.contains("surface-stale")).toBe(true);
    expect(el.getAttribute("aria-busy")).toBe("true");
  });

  it("treats an explicit isStale={false} the same as an absent prop", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts")]} rootPath={ROOT} isStale={false} />
    );
    const el = scroll(container);
    expect(el.classList.contains("surface-stale")).toBe(false);
    expect(el.getAttribute("aria-busy")).toBeNull();
  });

  it("applies surface-stale and aria-busy in the grouped branch when isStale", () => {
    const { container } = render(
      <FileChangeList
        changes={[file("src/a.ts"), file("test/b.ts")]}
        rootPath={ROOT}
        groupByFolder
        isStale
      />
    );
    const el = scroll(container);
    expect(el.classList.contains("surface-stale")).toBe(true);
    expect(el.getAttribute("aria-busy")).toBe("true");
    // Prove the grouped code path was entered, not the flat fallback.
    expect(el.querySelectorAll(".font-mono").length).toBeGreaterThan(0);
    // Exactly one container carries the stale class — never both branches.
    expect(container.querySelectorAll(".surface-stale").length).toBe(1);
  });

  it("clears stale styling when isStale toggles back to false", () => {
    const changes = [file("a.ts"), file("b.ts")];
    const { container, rerender } = render(
      <FileChangeList changes={changes} rootPath={ROOT} isStale />
    );
    expect(scroll(container).classList.contains("surface-stale")).toBe(true);

    act(() => {
      rerender(<FileChangeList changes={changes} rootPath={ROOT} isStale={false} />);
    });

    const el = scroll(container);
    expect(el.classList.contains("surface-stale")).toBe(false);
    expect(el.getAttribute("aria-busy")).toBeNull();
  });
});

describe("FileChangeList — focus restore & file stepping (#9217)", () => {
  beforeEach(() => {
    capturedModalProps.isOpen = false;
    capturedModalProps.filePath = "";
    capturedModalProps.restoreFocusTo = undefined;
    capturedModalProps.currentFileIndex = undefined;
    capturedModalProps.totalFileCount = undefined;
    capturedModalProps.onNavigateFile = undefined;
    capturedModalProps.onClose = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  function rows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[role="button"]'));
  }

  it("makes each row a focusable button with an accessible label", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts")]} rootPath={ROOT} />
    );
    const [first] = rows(container);
    expect(first).toBeTruthy();
    expect(first!.getAttribute("role")).toBe("button");
    expect(first!.getAttribute("tabindex")).toBe("0");
    expect(first!.getAttribute("aria-label")).toContain("a.ts");
  });

  it("opens the modal on Enter and passes the row as the focus-restore target", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts")]} rootPath={ROOT} />
    );
    const [first] = rows(container);
    fireEvent.keyDown(first!, { key: "Enter" });

    expect(capturedModalProps.isOpen).toBe(true);
    expect(capturedModalProps.filePath).toBe("a.ts");
    // restoreFocusTo is the identity-stable ref; its current points at the row.
    const ref = capturedModalProps.restoreFocusTo as { current: HTMLElement | null };
    expect(ref.current).toBe(first);
  });

  it("opens the modal on Space", () => {
    const { container } = render(<FileChangeList changes={[file("a.ts")]} rootPath={ROOT} />);
    fireEvent.keyDown(rows(container)[0]!, { key: " " });
    expect(capturedModalProps.isOpen).toBe(true);
  });

  it("opens the modal on click and reports the file index and total count", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts"), file("c.ts")]} rootPath={ROOT} />
    );
    // Sorted alphabetically (equal churn): a, b, c. Click the second row.
    fireEvent.click(rows(container)[1]!);

    expect(capturedModalProps.isOpen).toBe(true);
    expect(capturedModalProps.filePath).toBe("b.ts");
    expect(capturedModalProps.currentFileIndex).toBe(1);
    expect(capturedModalProps.totalFileCount).toBe(3);
  });

  it("steps to the next and previous file across the whole sorted set", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts"), file("c.ts")]} rootPath={ROOT} />
    );
    fireEvent.click(rows(container)[0]!);
    expect(capturedModalProps.currentFileIndex).toBe(0);

    act(() => capturedModalProps.onNavigateFile!(1));
    expect(capturedModalProps.currentFileIndex).toBe(1);
    expect(capturedModalProps.filePath).toBe("b.ts");

    act(() => capturedModalProps.onNavigateFile!(1));
    expect(capturedModalProps.currentFileIndex).toBe(2);
    expect(capturedModalProps.filePath).toBe("c.ts");

    act(() => capturedModalProps.onNavigateFile!(-1));
    expect(capturedModalProps.currentFileIndex).toBe(1);
    expect(capturedModalProps.filePath).toBe("b.ts");
  });

  it("clamps stepping at the boundaries", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts")]} rootPath={ROOT} />
    );
    fireEvent.click(rows(container)[0]!);

    // Step back from the first file stays at index 0.
    act(() => capturedModalProps.onNavigateFile!(-1));
    expect(capturedModalProps.currentFileIndex).toBe(0);

    // Step forward to the last, then past it — stays at the last index.
    act(() => capturedModalProps.onNavigateFile!(1));
    act(() => capturedModalProps.onNavigateFile!(1));
    expect(capturedModalProps.currentFileIndex).toBe(1);
    expect(capturedModalProps.filePath).toBe("b.ts");
  });

  it("can step into files beyond the visible cap", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      // Descending churn so the sort order matches the construction order.
      ({ ...file(`file-${String(i).padStart(2, "0")}.ts`), insertions: 100 - i })
    );
    const { container } = render(<FileChangeList changes={many} rootPath={ROOT} maxVisible={8} />);
    // Only 8 rows render, but stepping spans all 12.
    expect(rows(container).length).toBe(8);
    fireEvent.click(rows(container)[7]!);
    expect(capturedModalProps.currentFileIndex).toBe(7);
    expect(capturedModalProps.totalFileCount).toBe(12);

    act(() => capturedModalProps.onNavigateFile!(1));
    expect(capturedModalProps.currentFileIndex).toBe(8);
    expect(capturedModalProps.filePath).toBe("file-08.ts");
  });

  it("closing the modal clears the open state and selected index", () => {
    const { container } = render(<FileChangeList changes={[file("a.ts")]} rootPath={ROOT} />);
    fireEvent.click(rows(container)[0]!);
    expect(capturedModalProps.isOpen).toBe(true);
    expect(capturedModalProps.currentFileIndex).toBe(0);

    act(() => capturedModalProps.onClose!());
    expect(capturedModalProps.isOpen).toBe(false);
    expect(capturedModalProps.currentFileIndex).toBeUndefined();
  });
});

describe("FileChangeList — openFirstFile imperative handle (#11041)", () => {
  beforeEach(() => {
    capturedModalProps.isOpen = false;
    capturedModalProps.filePath = "";
    capturedModalProps.restoreFocusTo = undefined;
    capturedModalProps.currentFileIndex = undefined;
    capturedModalProps.totalFileCount = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it.each([false, true])(
    "opens the highest-churn file first and seeds the given trigger (groupByFolder=%s)",
    (groupByFolder) => {
      const ref = createRef<FileChangeListHandle>();
      // Raw order lists b.ts first, but a.ts has more churn, so it sorts to index 0.
      const changes = [
        { ...file("b.ts"), insertions: 1 },
        { ...file("a.ts"), insertions: 100 },
      ];
      render(
        <FileChangeList ref={ref} changes={changes} rootPath={ROOT} groupByFolder={groupByFolder} />
      );

      const trigger = document.createElement("button");
      act(() => ref.current!.openFirstFile(trigger));

      expect(capturedModalProps.isOpen).toBe(true);
      expect(capturedModalProps.filePath).toBe("a.ts");
      expect(capturedModalProps.currentFileIndex).toBe(0);
      const restore = capturedModalProps.restoreFocusTo as { current: HTMLElement | null };
      expect(restore.current).toBe(trigger);
    }
  );

  it("keeps the handle stable across an empty→populated transition and no-ops while empty", () => {
    const ref = createRef<FileChangeListHandle>();
    const { rerender } = render(<FileChangeList ref={ref} changes={[]} rootPath={ROOT} />);

    // The hook is registered above the empty-list early return, so the handle
    // exists even though nothing rendered; calling it is a safe no-op.
    expect(ref.current).not.toBeNull();
    act(() => ref.current!.openFirstFile(document.createElement("button")));
    expect(capturedModalProps.isOpen).toBe(false);

    act(() => {
      rerender(<FileChangeList ref={ref} changes={[file("a.ts")]} rootPath={ROOT} />);
    });
    act(() => ref.current!.openFirstFile(document.createElement("button")));
    expect(capturedModalProps.isOpen).toBe(true);
    expect(capturedModalProps.filePath).toBe("a.ts");
  });
});
