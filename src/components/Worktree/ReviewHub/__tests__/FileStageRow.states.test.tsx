/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { StagingFileEntry } from "@shared/types";

vi.mock("@/components/ui/TruncatedTooltip", () => ({
  TruncatedTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { FileStageRow } from "../FileStageRow";

const SOURCE: StagingFileEntry = {
  path: "src/store/worktreeTopologyStore.ts",
  status: "modified",
  insertions: 3,
  deletions: 1,
};
const GENERATED: StagingFileEntry = {
  path: "src/__generated__/schemaTypes.ts",
  status: "added",
  insertions: 40,
  deletions: 0,
};
const FILES = [SOURCE, GENERATED];

function renderRow(file: StagingFileEntry, opts: { viewed?: boolean; isStaged?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <FileStageRow
        file={file}
        section={opts.isStaged ? "staged" : "unstaged"}
        isStaged={opts.isStaged ?? false}
        isSelected={false}
        rowIndex={0}
        onToggle={vi.fn()}
        onRowClick={vi.fn()}
        viewed={opts.viewed ?? false}
        onViewedChange={vi.fn()}
      />
    </TooltipProvider>
  );
}

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

const opacityClass = (c: string) => /^opacity-/.test(c);

/** A text colour utility, as opposed to a text size one. */
const isInk = (c: string) =>
  /^text-/.test(c) && !/^text-(\d?xs|sm|base|lg|\d?xl|\[|left|right|center)/.test(c);

/** True when the element's transition-property list covers `opacity`. */
function transitionsOpacity(classes: string[]): boolean {
  return classes.some(
    (c) => c === "transition-opacity" || /^transition-\[[^\]]*\bopacity\b[^\]]*\]$/.test(c)
  );
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => cleanup());

/** The row's content — what a viewed file dims. Controls are deliberately absent. */
function contentPieces(file: StagingFileEntry): Record<string, Element> {
  const chip = screen
    .getByRole("button", { name: `View diff: ${file.path}` })
    .querySelector('span[aria-hidden="true"]');
  if (!chip) throw new Error("status chip not rendered");
  return {
    chip,
    dir: screen.getByTestId("file-stage-row-dir"),
    base: screen.getByTestId("file-stage-row-base"),
    churn: screen.getByTestId("file-stage-row-churn"),
  };
}

function piecesAt(file: StagingFileEntry, viewed: boolean): Record<string, string[]> {
  renderRow(file, { viewed });
  const out = Object.fromEntries(
    Object.entries(contentPieces(file)).map(([name, el]) => [name, classesOf(el)])
  );
  cleanup();
  return out;
}

const timing = (classes: string[]) => classes.filter((c) => /^(duration|ease)-/.test(c)).sort();

describe("FileStageRow — viewed dim", () => {
  it.each(FILES)("every content piece dims when viewed and eases both ways ($path)", (file) => {
    const rest = piecesAt(file, false);
    const viewed = piecesAt(file, true);
    const shared = timing(viewed.base ?? []);
    // A named duration and easing, not the browser's bare default.
    expect(shared.some((c) => c.startsWith("duration-"))).toBe(true);
    expect(shared.some((c) => c.startsWith("ease-"))).toBe(true);

    for (const name of Object.keys(viewed)) {
      const on = viewed[name] ?? [];
      const off = rest[name] ?? [];
      expect(on.filter(opacityClass), `${name} is not dimmed when viewed`).not.toEqual([]);
      expect(transitionsOpacity(on), `${name} snaps into the dim`).toBe(true);
      expect(transitionsOpacity(off), `${name} snaps out of the dim`).toBe(true);
      // One shared timing across the pieces, so the row recedes as one.
      expect(timing(on), name).toEqual(shared);
      expect(timing(off), name).toEqual(shared);
    }
  });

  it("never dims the row's controls, directly or through the row", () => {
    const file = SOURCE;
    const { container } = renderRow(file, { viewed: true });
    const controls = [
      screen.getByRole("button", { name: `Stage ${file.path}` }),
      screen.getByRole("checkbox", { name: `Mark ${file.path} as viewed` }),
    ];
    for (const el of controls) {
      for (let node: Element | null = el; node && node !== container; node = node.parentElement) {
        expect(classesOf(node).filter(opacityClass), node.outerHTML.slice(0, 120)).toEqual([]);
      }
    }
  });
});

describe("FileStageRow — stage control", () => {
  it.each([false, true])(
    "the glyph rests in the path's secondary ink and brightens to the filename's on hover and focus (staged=%s)",
    (isStaged) => {
      const file = SOURCE;
      renderRow(file, { isStaged });
      const button = screen.getByRole("button", {
        name: `${isStaged ? "Unstage" : "Stage"} ${file.path}`,
      });
      const svg = button.querySelector("svg");
      expect(svg).not.toBeNull();
      // A colour pinned on the icon would outrank the button's hover colour.
      expect(classesOf(svg!).filter(isInk)).toEqual([]);

      const classes = classesOf(button);
      const ink = (prefix: string) =>
        classes.filter((c) => c.startsWith(prefix) && isInk(c.slice(prefix.length)));
      // The row's own two inks are the vocabulary: its path at rest, its filename lit.
      const pathInk = classesOf(screen.getByTestId("file-stage-row-dir")).filter(isInk);
      const nameInk = classesOf(screen.getByTestId("file-stage-row-base")).filter(isInk);
      expect(ink("")).toEqual(pathInk);
      expect(ink("hover:").map((c) => c.slice("hover:".length))).toEqual(nameInk);
      expect(ink("focus-visible:").map((c) => c.slice("focus-visible:".length))).toEqual(nameInk);
      expect(nameInk).not.toEqual(pathInk);
    }
  );
});

describe("FileStageRow — hover classes", () => {
  it.each(FILES)("no hover variant repeats the resting value ($path)", (file) => {
    renderRow(file);
    const row = screen.getByTestId(`file-stage-row-${file.path}`);
    for (const el of [row, ...Array.from(row.querySelectorAll("*"))]) {
      const classes = classesOf(el);
      for (const c of classes) {
        const m = /^(?:group-hover\/\w+|hover):(.+)$/.exec(c);
        if (!m) continue;
        expect(classes, `${c} is a no-op on ${el.tagName}`).not.toContain(m[1]);
      }
    }
  });
});
