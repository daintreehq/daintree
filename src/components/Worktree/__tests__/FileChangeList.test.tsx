/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import type { FileChangeDetail } from "../../../types";

// The list no longer owns a diff modal: it opens a dialog-presented `diff`
// panel and keeps that panel's change set current. Stepping between files now
// belongs to DiffPane, so this file only asserts the opening contract.
const { openPanelDialogMock, setDiffPanelChangeSetMock, setDiffPanelFileMock } = vi.hoisted(() => ({
  openPanelDialogMock: vi.fn<(options: Record<string, unknown>) => Promise<string>>(
    async () => "diff-panel-1"
  ),
  setDiffPanelChangeSetMock: vi.fn(),
  setDiffPanelFileMock: vi.fn(),
}));

// Both stores are consumed two ways — as a hook with a selector and via
// `.getState()` — so the mock has to be a callable carrying `getState`.
vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ panelId: "diff-panel-1" }),
    { getState: () => ({ openPanelDialog: openPanelDialogMock }) }
  ),
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({
      setDiffPanelChangeSet: setDiffPanelChangeSetMock,
      setDiffPanelFile: setDiffPanelFileMock,
    }),
  }),
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

describe("FileChangeList — row activation opens the diff panel (#9217)", () => {
  beforeEach(() => {
    openPanelDialogMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  function rows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[role="button"]'));
  }

  function openedOptions(call = 0): Record<string, unknown> {
    const options = openPanelDialogMock.mock.calls[call]?.[0];
    if (!options) throw new Error("openPanelDialog was not called");
    return options;
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

  it("opens the diff panel on Enter", () => {
    const { container } = render(
      <FileChangeList changes={[file("a.ts"), file("b.ts")]} rootPath={ROOT} />
    );
    fireEvent.keyDown(rows(container)[0]!, { key: "Enter" });

    expect(openedOptions()).toMatchObject({ kind: "diff", filePath: "a.ts" });
  });

  it("opens the diff panel on Space", () => {
    const { container } = render(<FileChangeList changes={[file("a.ts")]} rootPath={ROOT} />);
    fireEvent.keyDown(rows(container)[0]!, { key: " " });

    expect(openedOptions()).toMatchObject({ kind: "diff", filePath: "a.ts" });
  });

  it("opens the clicked row's file and hands the panel the whole sorted change set", () => {
    // Descending churn, so the sorted set is c, b, a — a raw-order bug would
    // put a.ts first. Only the top 2 render, but the set must span all three.
    const changes = [
      { ...file("a.ts"), insertions: 1 },
      { ...file("b.ts"), insertions: 5 },
      { ...file("c.ts"), insertions: 50 },
    ];
    const { container } = render(
      <FileChangeList changes={changes} rootPath={ROOT} maxVisible={2} />
    );
    fireEvent.click(rows(container)[1]!);

    const options = openedOptions();
    expect(options.filePath).toBe("b.ts");
    const changeSet = options.changeSet as Array<{ path: string; status: string }>;
    expect(changeSet).toHaveLength(changes.length);
    expect(changeSet[0]).toMatchObject({ path: "c.ts", status: "modified" });
  });

  it("resolves an absolute change path against the root before opening", () => {
    const { container } = render(
      <FileChangeList changes={[file(`${ROOT}/src/deep/a.ts`)]} rootPath={ROOT} />
    );
    fireEvent.click(rows(container)[0]!);

    const options = openedOptions();
    expect(options.filePath).toBe("src/deep/a.ts");
    expect(options.title).toBe("a.ts");
  });
});

describe("FileChangeList — openFirstFile imperative handle (#11041)", () => {
  beforeEach(() => {
    openPanelDialogMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it.each([false, true])(
    "opens the highest-churn file first (groupByFolder=%s)",
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

      act(() => ref.current!.openFirstFile(document.createElement("button")));

      const options = openPanelDialogMock.mock.calls[0]?.[0];
      expect(options).toMatchObject({ kind: "diff", filePath: "a.ts" });
      // The set is handed over in the same sorted order the handle opened from.
      const changeSet = options!.changeSet as Array<{ path: string }>;
      expect(changeSet.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
    }
  );

  it("keeps the handle available across an empty→populated transition and no-ops while empty", () => {
    const ref = createRef<FileChangeListHandle>();
    const { rerender } = render(<FileChangeList ref={ref} changes={[]} rootPath={ROOT} />);

    // The hook is registered above the empty-list early return, so the handle
    // exists even though nothing rendered; calling it is a safe no-op.
    expect(ref.current).not.toBeNull();
    act(() => ref.current!.openFirstFile(document.createElement("button")));
    expect(openPanelDialogMock).not.toHaveBeenCalled();

    act(() => {
      rerender(<FileChangeList ref={ref} changes={[file("a.ts")]} rootPath={ROOT} />);
    });
    // Rendering a file must not open anything on its own — the open below has
    // to be a real effect of the call, not a leftover from the transition.
    expect(openPanelDialogMock).not.toHaveBeenCalled();

    act(() => ref.current!.openFirstFile(document.createElement("button")));
    expect(openPanelDialogMock.mock.calls[0]?.[0]).toMatchObject({ filePath: "a.ts" });
  });
});
