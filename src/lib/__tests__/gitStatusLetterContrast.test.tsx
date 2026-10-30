/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  BUILT_IN_APP_SCHEMES,
  DISPLAY_SURFACES,
  blendOverBackground,
  contrastRatio,
  type AppThemeTokenKey,
} from "@shared/theme";
import type { GitStatus } from "@shared/types/git";

vi.mock("@/components/ui/TruncatedTooltip", () => ({
  TruncatedTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { GIT_STATUS_PRESENTATION } from "../gitStatusPresentation";
import { DIFF_STATUS_CONFIG } from "@/components/FileViewer/diffChangeSet";
import { getBaseBranchStatusConfig } from "@/components/Worktree/ReviewHub/reviewHubUtils";
import { FileStageRow } from "@/components/Worktree/ReviewHub/FileStageRow";

// Every list that letters a git status, read through the classes it actually
// paints. A status letter is small text, so it owes AA on every built-in theme,
// bare or on its badge wash, and the lists move together: one drifting back to a
// graphical `status-*` ink fails here on the themes where that ink is 3:1 grade.

const STATUSES = Object.keys(GIT_STATUS_PRESENTATION) as GitStatus[];

/** Tailwind colour names that are aliases for another token. */
const ALIASES: Record<string, AppThemeTokenKey> = { "status-error": "status-danger" };

function token(name: string): AppThemeTokenKey {
  return ALIASES[name] ?? (name as AppThemeTokenKey);
}

/** The letter's ink: `text-status-danger-text` → `status-danger-text`, `text-text-primary` → `text-primary`. */
function inkOf(classes: string): AppThemeTokenKey {
  const inks = classes
    .split(/\s+/)
    .map((c) => /^text-((?:status|text)-[a-z-]+)$/.exec(c)?.[1])
    .filter((name): name is string => name !== undefined);
  expect(inks, classes).toHaveLength(1);
  return token(inks[0]!);
}

/** The badge wash: `bg-status-success/15` or `bg-tint/[0.06]`. */
function washOf(classes: string): { token: AppThemeTokenKey; opacity: number } | null {
  for (const c of classes.split(/\s+/)) {
    const match = /^bg-([a-z-]+)\/(?:(\d+)|\[([\d.]+)\])$/.exec(c);
    if (match) {
      const opacity = match[2] ? Number(match[2]) / 100 : Number(match[3]);
      return { token: token(match[1]!), opacity };
    }
  }
  return null;
}

function expectLegible(where: string, classes: string): void {
  const ink = inkOf(classes);
  const wash = washOf(classes);
  for (const scheme of BUILT_IN_APP_SCHEMES) {
    for (const surfaceKey of DISPLAY_SURFACES) {
      const surface = scheme.tokens[surfaceKey];
      const backdrop = wash
        ? blendOverBackground(scheme.tokens[wash.token], surface, wash.opacity)
        : surface;
      const ratio = contrastRatio(scheme.tokens[ink], backdrop);
      expect(
        ratio,
        `${where} on ${scheme.id} ${surfaceKey}: ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => cleanup());

describe("git status letter contrast", () => {
  it.each(STATUSES)("the shared presentation letters %s legibly", (status) => {
    expectLegible(`presentation ${status}`, GIT_STATUS_PRESENTATION[status].colorClass);
  });

  it.each(STATUSES)("the diff shelf letters %s legibly", (status) => {
    expectLegible(`diff shelf ${status}`, DIFF_STATUS_CONFIG[status].color);
  });

  it.each(["A", "D", "M", "R", "C", "U", "T"])(
    "the vs-main and Since lists badge %s legibly",
    (letter) => {
      const config = getBaseBranchStatusConfig(letter);
      expectLegible(`base-branch ${letter}`, `${config.bg} ${config.text}`);
    }
  );

  it.each(STATUSES)("the working-tree rows badge %s legibly", (status) => {
    const path = `src/${status}.ts`;
    render(
      <TooltipProvider>
        <FileStageRow
          file={{ path, status, insertions: 1, deletions: 0 }}
          section="unstaged"
          isStaged={false}
          isSelected={false}
          rowIndex={0}
          onToggle={vi.fn()}
          onRowClick={vi.fn()}
        />
      </TooltipProvider>
    );
    const chip = screen
      .getByRole("button", { name: `View diff: ${path}` })
      .querySelector('span[aria-hidden="true"]');
    expect(chip?.textContent).toBe(GIT_STATUS_PRESENTATION[status].marker);
    expectLegible(`working-tree ${status}`, chip!.getAttribute("class") ?? "");
  });
});
