import { DaintreeIcon } from "@/components/icons";
import type { AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { MockLines, MockPane, reveal, type MockAgentId } from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";

const PANES: ReadonlyArray<{ agent: MockAgentId; state: AgentState; lines: number[] }> = [
  { agent: "claude", state: "working", lines: [82, 64, 90, 48] },
  { agent: "codex", state: "working", lines: [70, 88, 56] },
  { agent: "gemini", state: "waiting", lines: [92, 60, 74, 40] },
  { agent: "claude", state: "completed", lines: [66, 84, 52] },
];

export function WelcomeScene() {
  const first = useCue("first");
  const grid = useCue("grid");

  return (
    <div className="relative size-full">
      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-3",
          reveal(!first, "none")
        )}
      >
        <DaintreeIcon className="size-12 text-text-primary" />
        <span className="text-lg font-semibold tracking-tight text-text-primary">Daintree</span>
      </div>

      <div className="absolute left-[100px] top-[22px] grid h-[262px] w-[440px] grid-cols-2 grid-rows-2 gap-2.5">
        {PANES.map((pane, i) => {
          const visible = i === 0 ? first : grid;
          return (
            <div
              key={i}
              className={cn("flex min-h-0", reveal(visible))}
              style={{ transitionDelay: visible && i > 0 ? `${(i - 1) * 140}ms` : undefined }}
            >
              <MockPane
                agent={pane.agent}
                state={i === 0 && !grid ? "working" : pane.state}
                className="w-full"
              >
                <MockLines widths={pane.lines} />
              </MockPane>
            </div>
          );
        })}
      </div>
    </div>
  );
}
