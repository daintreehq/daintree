import type { AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { MockApp, MockGrid, MockWaitingPill, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockLines,
  MockPane,
  MockStreamingLines,
  reveal,
  type MockAgentId,
} from "../mockup/TourMock";
import { useCue } from "@daintreehq/tour/react";
import { MockEmptyGrid } from "./sceneParts";

const PANES: ReadonlyArray<{
  agent: MockAgentId;
  state: AgentState;
  lines: number[];
  /** The cue this pane arrives on; a working pane streams output from it. */
  cue: string;
}> = [
  { agent: "claude", state: "working", lines: [82, 64, 90, 48, 76, 58, 86, 44], cue: "first" },
  { agent: "codex", state: "working", lines: [70, 88, 56, 80, 62, 92, 50], cue: "second" },
  { agent: "antigravity", state: "waiting", lines: [92, 60, 74, 40], cue: "grid" },
  { agent: "claude", state: "completed", lines: [66, 84, 52, 72, 46], cue: "grid" },
];

export function WelcomeScene() {
  const first = useCue("first");
  const second = useCue("second");
  const grid = useCue("grid");
  const watch = useCue("watch");
  // Each agent arrives as it's named, as a new column; "side by side" fills the grid.
  const shown = grid ? PANES : second ? PANES.slice(0, 2) : first ? PANES.slice(0, 1) : [];

  return (
    <MockApp
      worktrees={
        <>
          <MockWorktreeCard
            name="shop-app"
            branch="main"
            selected
            states={shown.map((pane) => pane.state)}
          />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
        </>
      }
      grid={
        shown.length === 0 ? (
          <MockEmptyGrid label="shop-app" />
        ) : (
          <MockGrid columns={grid ? 2 : shown.length} rows={grid ? 2 : 1}>
            {shown.map((pane, i) => (
              <div
                key={i}
                className={cn("flex min-h-0", reveal(true))}
                style={{ transitionDelay: grid && i > 0 ? `${(i - 1) * 140}ms` : undefined }}
              >
                <MockPane agent={pane.agent} state={pane.state} className="w-full">
                  {pane.state === "working" ? (
                    <MockStreamingLines cue={pane.cue} widths={pane.lines} perSecond={1.2} />
                  ) : (
                    <MockLines widths={pane.lines} />
                  )}
                </MockPane>
              </div>
            ))}
          </MockGrid>
        )
      }
      dock={<MockWaitingPill count={1} className={reveal(watch, "none")} />}
    />
  );
}
