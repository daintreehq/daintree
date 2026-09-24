import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MockAgentIcon,
  MockCursor,
  MockPane,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";

const CLAUDE_BUTTON = { x: 248, y: 35 };
const INPUT_BAR = { x: 300, y: 276 };
const PROMPT = "Add a search box to the header";

const CURSOR: readonly CursorStep[] = [
  { cue: "pick", at: CLAUDE_BUTTON },
  { cue: "pick", offset: 0.6, at: CLAUDE_BUTTON, click: true },
  { cue: "type", at: INPUT_BAR },
  { cue: "type", offset: 0.6, at: INPUT_BAR, click: true },
];

export function AgentsScene() {
  const open = useCue("open");
  const sent = useCue("send");
  const enterFaded = useCue("send", 0.9);
  const enterFlash = sent && !enterFaded;
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <div className="relative size-full">
      <div className="absolute left-[232px] top-[20px] flex h-8 items-center gap-1 rounded-lg border border-border-default bg-surface-toolbar px-1.5">
        {(["claude", "codex", "gemini"] as const).map((agent) => (
          <span key={agent} className="flex size-6 items-center justify-center rounded-md">
            <MockAgentIcon agent={agent} className="size-4" />
          </span>
        ))}
        <span className="mx-1 h-4 w-px bg-border-default" />
        <span className="flex size-6 items-center justify-center rounded-md text-text-secondary">
          <Plus className="size-3.5" aria-hidden="true" />
        </span>
      </div>

      <div
        className={cn("absolute left-[150px] top-[66px] flex h-[226px] w-[340px]", reveal(open))}
      >
        <MockPane
          agent="claude"
          state={sent ? "working" : null}
          focused={open}
          className="w-full"
          input={sent ? null : <MockTyping cue="type" text={PROMPT} delay={0.7} />}
          inputAddon={
            <span
              className={cn(
                "rounded-sm border border-border-strong px-1 text-3xs text-text-secondary transition-opacity duration-150 ease-out",
                enterFlash ? "opacity-100" : "opacity-0"
              )}
            >
              Enter
            </span>
          }
        >
          <div className={cn("mb-2.5 text-2xs text-text-secondary", reveal(sent, "none"))}>
            › {PROMPT}
          </div>
          <MockStreamingLines cue="send" delay={0.5} widths={[88, 72, 94, 60, 80]} perSecond={3} />
        </MockPane>
      </div>

      <MockCursor {...cursor} />
    </div>
  );
}
