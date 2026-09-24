import { CirclePause } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import { MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockAgentIcon,
  MockLines,
  MockPane,
  MockStateGlyph,
  reveal,
  type MockAgentId,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockKeys, MockSearchField, MockSpotlight } from "./sceneParts";

const PALETTE = { x: 150, y: 44, width: 340 } as const;

interface Run {
  agent: MockAgentId;
  title: string;
  state: AgentState;
  age: string;
}

const PROJECTS: ReadonlyArray<{ name: string; current?: boolean; runs: readonly Run[] }> = [
  {
    name: "shop-app",
    current: true,
    runs: [
      { agent: "codex", title: "Fix login redirect", state: "waiting", age: "2m" },
      { agent: "claude", title: "Add search to the header", state: "working", age: "6m" },
    ],
  },
  {
    name: "api-server",
    runs: [
      { agent: "antigravity", title: "Rate limit the public API", state: "waiting", age: "11m" },
      { agent: "claude", title: "Migrate billing tables", state: "completed", age: "40m" },
    ],
  },
];

// Parking is for something asking for you that can wait: api-server's waiting run.
const PARK = { group: 1, title: "Rate limit the public API" };

/** A group's rows in display order: a parked run ranks below everything else. */
function ordered(runs: readonly Run[], parkedTitle: string | null): readonly Run[] {
  if (!parkedTitle) return runs;
  const parked = runs.filter((run) => run.title === parkedTitle);
  return [...runs.filter((run) => run.title !== parkedTitle), ...parked];
}

/** The park editor, which takes the list's place until the park is submitted. */
function ParkEditor() {
  return (
    <div className="flex flex-col gap-2 px-1.5 py-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <MockAgentIcon agent="antigravity" className="size-3" />
        <span className="min-w-0 truncate text-3xs text-text-primary">{PARK.title}</span>
        <span className="shrink-0 text-3xs text-text-secondary">api-server</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-3xs font-medium text-text-secondary">Note</span>
        <span className="flex h-5 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs text-text-secondary">
          Why is this parked? (optional)
        </span>
      </div>
      <span className="self-end rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse">
        Park
      </span>
    </div>
  );
}

export function PilotScene() {
  const keys = useCue("open");
  const open = useCue("open", 1.8);
  const sort = useCue("sort");
  const parkCue = useCue("park");
  // Option Enter opens the park editor; Enter submits it.
  const parkKeys = useCue("park", 0.9);
  const editing = useCue("park", 0.7);
  const enterKey = useCue("park", 1.9);
  const parked = useCue("park", 2.5);
  const editorOpen = editing && !parked;

  return (
    <MockApp
      branch="add-search"
      focus={open ? [] : undefined}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard
            name="fix-login-redirect"
            branch="fix-login-redirect"
            states={["waiting"]}
          />
          <MockWorktreeCard name="add-search" branch="add-search" selected states={["working"]} />
        </>
      }
      grid={
        <MockGrid columns={1}>
          <MockPane agent="claude" state="working">
            <MockLines widths={[80, 56, 90, 64, 72, 48]} />
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
          <span className="text-text-secondary">Search agents…</span>
        </MockSearchField>
        {editorOpen && <ParkEditor />}
        {!editorOpen &&
          PROJECTS.map((project, g) => (
            <div key={project.name} className="flex flex-col">
              <span className="flex items-center gap-1.5 px-1 py-0.5 text-3xs font-semibold text-text-secondary">
                {project.name}
                {project.current && <span className="font-normal">· Current</span>}
              </span>
              {ordered(project.runs, parked && g === PARK.group ? PARK.title : null).map(
                (run, i) => {
                  const isTarget = g === PARK.group && run.title === PARK.title;
                  const isParked = parked && isTarget;
                  return (
                    <div
                      key={run.title}
                      data-tour-anchor={`pilot-row-${g}-${i}`}
                      className={cn(
                        "flex h-[18px] items-center gap-1.5 rounded-md px-1.5 transition-colors duration-150 ease-out",
                        isTarget && parkCue && !parked ? "bg-overlay-selected" : "bg-transparent"
                      )}
                    >
                      <span className="flex size-3 shrink-0 items-center justify-center">
                        {isParked ? (
                          <CirclePause
                            className="size-2.5 text-text-secondary"
                            aria-hidden="true"
                          />
                        ) : (
                          <MockStateGlyph state={run.state} />
                        )}
                      </span>
                      <MockAgentIcon agent={run.agent} className="size-3" />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-3xs",
                          isParked ? "text-text-secondary" : "text-text-primary"
                        )}
                      >
                        {run.title}
                      </span>
                      <span className="w-5 text-right text-3xs tabular-nums text-text-secondary">
                        {run.age}
                      </span>
                    </div>
                  );
                }
              )}
            </div>
          ))}
        <div className="mt-1.5 flex items-center gap-3 border-t border-border-subtle px-1 pt-1.5 text-3xs text-text-secondary">
          <span>
            <span className="text-text-primary">↵</span> Open
          </span>
          <span data-tour-anchor="pilot-park">
            <span className="text-text-primary">⌥↵</span> Park
          </span>
        </div>
      </div>
      <MockKeys keys={["⌥", "↵"]} x={320} y={300} visible={parkCue && !parkKeys} />
      <MockKeys keys={["↵"]} x={320} y={300} visible={enterKey && !parked} />
      {/* "Whatever is waiting on you" — the top of each group, then the Park hint. */}
      <MockSpotlight
        targets={parkCue ? ["pilot-park"] : ["pilot-row-0-0", "pilot-row-1-0"]}
        visible={(sort && !parkCue) || (parkCue && !editing)}
      />
    </MockApp>
  );
}
