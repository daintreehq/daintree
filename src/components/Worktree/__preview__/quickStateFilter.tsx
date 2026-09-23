import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QuickStateFilter } from "@/lib/worktreeFilters";
import { QuickStateFilterBar } from "../QuickStateFilterBar";
import { QuickStateArmButton } from "../QuickStateArmButton";
import "@/index.css";

/**
 * Standalone visual-review harness for the sidebar's quick state filter bar.
 *
 * The bar is purely presentational — a value, counts, and a trailing slot — so
 * booting Electron to photograph it would buy nothing but the ten minutes it
 * costs. This renders the REAL `QuickStateFilterBar` and `QuickStateArmButton`
 * against the real theme tokens and the real `index.css`, in the sidebar's
 * column, with the rows above and below drawn as harness decoration so the
 * bar's weight is judged against what it actually separates.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib   built-in theme id
 *   ?fixture=<name>               one of FIXTURE_NAMES below
 *   ?width=320                    sidebar width in CSS px
 */

type Counts = Record<QuickStateFilter, number>;

interface Fixture {
  value: QuickStateFilter;
  counts?: Counts;
  armDisabled?: boolean;
}

const FIXTURES: Record<string, Fixture> = {
  /** The state in the owner's screenshot. */
  default: { value: "all", counts: { all: 3, working: 2, waiting: 1, finished: 0 } },
  "working-active": { value: "working", counts: { all: 3, working: 2, waiting: 1, finished: 0 } },
  "waiting-active": { value: "waiting", counts: { all: 3, working: 2, waiting: 1, finished: 0 } },
  "finished-active": { value: "finished", counts: { all: 6, working: 1, waiting: 1, finished: 4 } },
  /** Nothing running: every status bucket empty, nothing to arm. */
  idle: {
    value: "all",
    counts: { all: 5, working: 0, waiting: 0, finished: 0 },
    armDisabled: true,
  },
  /** Every bucket populated, the most glyph colour the bar ever carries. */
  mixed: { value: "all", counts: { all: 9, working: 3, waiting: 2, finished: 4 } },
  /** Two-digit counts — the width case. */
  busy: { value: "all", counts: { all: 42, working: 17, waiting: 12, finished: 13 } },
  /** Counts not yet derived. */
  "no-counts": { value: "all" },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "320");
const fixtureName = params.get("fixture") ?? "default";
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

/** Worktree rows, drawn so the bar has the density it sits between. Harness decoration. */
function Rows({ names, selected }: { names: string[]; selected?: number }) {
  return (
    <div data-harness-decoration aria-hidden="true" className="flex flex-col gap-1 px-3 py-2">
      {names.map((name, i) => (
        <div
          key={name}
          className={`flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 ${
            i === selected ? "bg-overlay-subtle" : ""
          }`}
        >
          <span className="h-4 w-4 shrink-0 rounded-[var(--radius-sm)] bg-overlay-medium" />
          <span className="truncate text-xs text-text-secondary">{name}</span>
        </div>
      ))}
    </div>
  );
}

function Preview({ initial }: { initial: Fixture }) {
  const [value, setValue] = useState<QuickStateFilter>(initial.value);
  return (
    <div
      data-preview-shell
      className="flex flex-col surface-sidebar"
      style={{ width: `${width}px`, height: "260px" }}
    >
      <Rows names={["main"]} />
      {/* The strong divider SidebarContent draws between the pinned rows and the bar. */}
      <div className="shrink-0 border-b border-border-default" />
      <div data-filter-region>
        <QuickStateFilterBar
          value={value}
          onChange={setValue}
          counts={initial.counts}
          trailing={
            <QuickStateArmButton
              label={initial.armDisabled ? "No agents to arm" : "Arm all 3 agents"}
              disabled={initial.armDisabled ?? false}
              onArm={() => undefined}
            />
          }
        />
      </div>
      <Rows
        names={["design-sidebar-filter", "issue-12488-handback", "feature/plugin-hosted-mcps"]}
        selected={0}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Preview initial={fixture} />
    </TooltipProvider>
  </StrictMode>
);
