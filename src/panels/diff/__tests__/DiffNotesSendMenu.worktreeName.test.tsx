// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DiffNoteTarget } from "@/hooks/useDiffNoteDelivery";

const { targetsMock } = vi.hoisted(() => ({
  targetsMock: { current: [] as DiffNoteTarget[] },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/hooks/useDiffNoteDelivery", () => ({
  deliverDiffNotes: vi.fn(),
  useDiffNoteTargets: () => targetsMock.current,
}));
vi.mock("@/components/Terminal/TerminalIcon", () => ({ TerminalIcon: () => null }));
// The real TruncatedTooltip runs; only Radix's tooltip is replaced, so its
// content is in the DOM exactly when TruncatedTooltip decides the text is cut.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { DiffNotesSendMenu } from "../DiffNotesSendMenu";
import { useDiffNotesStore } from "@/store/diffNotesStore";

const LONG_NAME = "feature-issue-17282-review-hub-file-rows-never-trigger-path";

// jsdom lays nothing out: the clipping box that holds `cutText` overflows, and
// every other box fits.
let cutText: string | null = null;
const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

function restore(name: "scrollWidth" | "clientWidth", original?: PropertyDescriptor) {
  if (original) Object.defineProperty(HTMLElement.prototype, name, original);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("truncate") && this.textContent === cutText ? 280 : 140;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 140,
  });
});

afterAll(() => {
  restore("scrollWidth", originalScrollWidth);
  restore("clientWidth", originalClientWidth);
});

beforeEach(() => {
  useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  useDiffNotesStore.getState().addNote({
    worktreePath: "/repo",
    filePath: "src/a.ts",
    anchor: { kind: "lines", side: "new", startLine: 2, endLine: 5, contentHash: "h" },
    body: "Fix this",
  });
  targetsMock.current = [
    {
      id: "t1",
      title: "Claude",
      isInputLocked: false,
      kind: "terminal",
      chrome: {} as DiffNoteTarget["chrome"],
      worktreeId: "wt",
      worktreeName: LONG_NAME,
    },
  ];
});

afterEach(() => {
  cleanup();
  cutText = null;
});

function openMenu() {
  render(
    <DiffNotesSendMenu
      worktreePath="/repo"
      worktreeId="wt"
      filePath="src/a.ts"
      onResult={() => undefined}
    />
  );
  fireEvent.pointerDown(screen.getByTestId("diff-notes-send"), { button: 0, ctrlKey: false });
  return screen.getByRole("menu");
}

function tooltips(): string[] {
  return screen.queryAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
}

describe("DiffNotesSendMenu worktree name", () => {
  it("draws no native title on an agent row", () => {
    cutText = LONG_NAME;
    const menu = openMenu();
    expect(menu.querySelector("[title]")).toBeNull();
  });

  it("discloses a cut worktree name in a tooltip, with no tab stop inside the item", () => {
    cutText = LONG_NAME;
    openMenu();
    expect(tooltips()).toEqual([LONG_NAME]);
    const item = screen.getByRole("menuitem", { name: `Claude, ${LONG_NAME}` });
    expect(item.querySelector('[tabindex="0"]')).toBeNull();
  });

  it("discloses the fallback for an agent with no worktree when it is cut", () => {
    targetsMock.current = [{ ...targetsMock.current[0]!, worktreeName: null }];
    cutText = "No worktree";
    openMenu();
    expect(tooltips()).toEqual(["No worktree"]);
  });

  it("shows no tooltip while the name fits", () => {
    openMenu();
    expect(tooltips()).toEqual([]);
  });
});
