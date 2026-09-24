import { Plus } from "lucide-react";
import { HollowCircle } from "@/components/icons";
import { STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import {
  MockCursor,
  MockLines,
  MockPane,
  reveal,
  useMockCursor,
  type CursorStep,
  type MockAgentId,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";

const PILL = { x: 446, y: 272 };

const CURSOR: readonly CursorStep[] = [
  { cue: "jump", at: PILL },
  { cue: "jump", offset: 0.6, at: PILL, click: true },
];

function StateRow({
  agent,
  state,
  label,
  showLabel,
  focused,
}: {
  agent: MockAgentId;
  state: AgentState | null;
  label: string;
  showLabel: boolean;
  focused: boolean;
}) {
  return (
    <div className="relative flex items-center">
      <MockPane agent={agent} state={state} focused={focused} className="h-[68px] w-[300px]">
        <MockLines widths={[78, 54]} />
      </MockPane>
      <span
        className={cn(
          "absolute left-[316px] top-[6px] text-2xs font-medium text-text-secondary",
          reveal(showLabel, "left")
        )}
      >
        {label}
      </span>
    </div>
  );
}

export function StateScene() {
  const working = useCue("working");
  const waiting = useCue("waiting");
  const done = useCue("done");
  const pill = useCue("pill");
  const jumped = useCue("jump", 0.8);
  const cursor = useMockCursor({ x: 560, y: 250 }, CURSOR);

  return (
    <div className="relative size-full">
      <div className="absolute left-[170px] top-[16px] flex flex-col gap-2.5">
        <StateRow
          agent="claude"
          state={working ? "working" : null}
          label="working"
          showLabel={working && !waiting}
          focused={false}
        />
        <StateRow
          agent="codex"
          state={waiting ? "waiting" : working ? "working" : null}
          label="waiting for you"
          showLabel={waiting && !done}
          focused={jumped}
        />
        <StateRow
          agent="gemini"
          state={done ? "completed" : working ? "working" : null}
          label="done"
          showLabel={done && !pill}
          focused={false}
        />
      </div>

      <div
        className={cn(
          "absolute left-[170px] top-[254px] flex h-9 w-[300px] items-center justify-between rounded-lg border border-border-default bg-surface-toolbar px-2",
          reveal(pill)
        )}
      >
        <span className="flex size-6 items-center justify-center text-text-secondary">
          <Plus className="size-3.5" aria-hidden="true" />
        </span>
        <span className="flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-panel px-2.5 py-1">
          <HollowCircle className={cn("size-3", STATE_COLORS.waiting)} />
          <span className="text-2xs font-medium text-text-primary">Waiting</span>
          <span className="text-2xs tabular-nums text-text-secondary">1</span>
        </span>
      </div>

      <MockCursor {...cursor} />
    </div>
  );
}
