import type { AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { MockApp, MockGrid, MockWaitingPill, MockWorktreeCard } from "../mockup/MockApp";
import { MockLines, MockPane, reveal, type MockAgentId } from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockEmptyGrid } from "./sceneParts";

const PANES: ReadonlyArray<{ agent: MockAgentId; state: AgentState; lines: number[] }> = [
  { agent: "claude", state: "working", lines: [82, 64, 90, 48] },
  { agent: "codex", state: "working", lines: [70, 88, 56] },
  { agent: "antigravity", state: "waiting", lines: [92, 60, 74, 40] },
  { agent: "claude", state: "completed", lines: [66, 84, 52] },
];

export function WelcomeScene() {
  const first = useCue("first");
  const grid = useCue("grid");
  const shown = grid ? PANES : first ? PANES.slice(0, 1) : [];

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
          <MockGrid columns={grid ? 2 : 1} rows={grid ? 2 : 1}>
            {shown.map((pane, i) => (
              <div
                key={i}
                className={cn("flex min-h-0", reveal(true))}
                style={{ transitionDelay: grid && i > 0 ? `${(i - 1) * 140}ms` : undefined }}
              >
                <MockPane agent={pane.agent} state={pane.state} className="w-full">
                  <MockLines widths={pane.lines} />
                </MockPane>
              </div>
            ))}
          </MockGrid>
        )
      }
      dock={<MockWaitingPill count={1} className={reveal(grid, "none")} />}
    />
  );
}
