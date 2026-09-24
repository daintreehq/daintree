import { Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import { MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockAgentIcon,
  MockCursor,
  MockLines,
  MockPane,
  MockStateGlyph,
  reveal,
  useMockCursor,
  type CursorStep,
  type MockAgentId,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockKeys, MockSearchField, MockSpotlight } from "./sceneParts";

const PALETTE = { x: 150, y: 44, width: 340 } as const;

interface Run {
  agent: MockAgentId;
  title: string;
  where: string;
  state: AgentState;
  age: string;
}

const PROJECTS: ReadonlyArray<{ name: string; runs: readonly Run[] }> = [
  {
    name: "shop-app",
    runs: [
      {
        agent: "codex",
        title: "Fix login redirect",
        where: "fix-login-redirect",
        state: "waiting",
        age: "2m",
      },
      {
        agent: "claude",
        title: "Add search to the header",
        where: "add-search",
        state: "working",
        age: "6m",
      },
    ],
  },
  {
    name: "api-server",
    runs: [
      {
        agent: "antigravity",
        title: "Rate limit the public API",
        where: "feat/rate-limits",
        state: "waiting",
        age: "11m",
      },
      {
        agent: "claude",
        title: "Migrate billing tables",
        where: "feat/billing",
        state: "completed",
        age: "40m",
      },
    ],
  },
];

// Rows are 18px under a 64px header (title, search, filters, group label).
const rowY = (group: number, i: number) => PALETTE.y + 64 + group * 58 + i * 18;
// Parking is for something asking for you that can wait: the waiting run.
const PARK_ROW = { group: 1, i: 0 };

const CURSOR: readonly CursorStep[] = [
  { cue: "park", at: { x: PALETTE.x + 160, y: rowY(PARK_ROW.group, PARK_ROW.i) + 9 } },
  {
    cue: "park",
    offset: 0.5,
    at: { x: PALETTE.x + 160, y: rowY(PARK_ROW.group, PARK_ROW.i) + 9 },
    click: true,
  },
];

export function PilotScene() {
  const keys = useCue("open");
  const open = useCue("open", 0.8);
  const sort = useCue("sort");
  const parked = useCue("park", 0.9);
  const cursor = useMockCursor({ x: 420, y: 300 }, CURSOR);

  return (
    <MockApp
      focus={open ? [] : undefined}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" selected />
          <MockWorktreeCard name="add-search" branch="add-search" states={["working"]} />
          <MockWorktreeCard
            name="fix-login-redirect"
            branch="fix-login-redirect"
            states={["waiting"]}
          />
        </>
      }
      grid={
        <MockGrid columns={2}>
          <MockPane agent="claude" state="working">
            <MockLines widths={[80, 56, 90, 64]} />
          </MockPane>
          <MockPane agent="codex" state="waiting">
            <MockLines widths={[70, 84, 52]} />
          </MockPane>
        </MockGrid>
      }
    >
      <MockKeys keys={["⌘", "⌥", "O"]} x={320} y={180} visible={keys && !open} />
      <div
        className={cn(
          "absolute z-20 flex flex-col rounded-lg border border-border-strong bg-surface-dialog p-2 shadow-[var(--theme-shadow-ambient)]",
          reveal(open)
        )}
        style={{ left: PALETTE.x, top: PALETTE.y, width: PALETTE.width }}
      >
        <span className="mb-1.5 px-1 text-2xs font-semibold text-text-primary">All agents</span>
        <MockSearchField>
          <span className="text-text-placeholder">Search agents…</span>
        </MockSearchField>
        <div className="mb-1 flex items-center gap-1 px-0.5 text-3xs">
          {["All", "Attention", "Working", "Finished", "Parked"].map((filter, i) => (
            <span
              key={filter}
              className={cn(
                "rounded-sm px-1.5 py-px",
                i === 0 ? "bg-overlay-selected text-text-primary" : "text-text-secondary"
              )}
            >
              {filter}
            </span>
          ))}
        </div>
        {PROJECTS.map((project, g) => (
          <div key={project.name} className="flex flex-col">
            <span className="px-1 py-0.5 text-3xs font-semibold text-text-secondary">
              {project.name}
            </span>
            {project.runs.map((run, i) => {
              const isParked = parked && g === PARK_ROW.group && i === PARK_ROW.i;
              return (
                <div
                  key={run.title}
                  data-tour-anchor={`pilot-row-${g}-${i}`}
                  className={cn(
                    "flex h-[18px] items-center gap-1.5 rounded-md px-1.5 transition-opacity duration-200 ease-out",
                    isParked ? "opacity-45" : "opacity-100"
                  )}
                >
                  <MockAgentIcon agent={run.agent} className="size-3" />
                  <span className="min-w-0 flex-1 truncate text-3xs text-text-primary">
                    {run.title}
                  </span>
                  <span className="truncate text-3xs text-text-secondary">{run.where}</span>
                  {isParked ? (
                    <span className="flex items-center gap-0.5 text-3xs text-text-secondary">
                      <Pause className="size-2.5" aria-hidden="true" />
                      Parked
                    </span>
                  ) : (
                    <MockStateGlyph state={run.state} />
                  )}
                  <span className="w-5 text-right text-3xs tabular-nums text-text-secondary">
                    {run.age}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {/* "Whatever is blocked or waiting on you comes first" — the top of each group. */}
      <MockSpotlight targets={["pilot-row-0-0", "pilot-row-1-0"]} visible={sort && !parked} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
