import { Copy, RadioTower, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MockCursor,
  MockPane,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
  type MockAgentId,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";

const PANES: readonly MockAgentId[] = ["claude", "codex", "gemini"];
const PANE_LEFT = [40, 225, 410] as const;
const PROMPT = "Run the tests and fix failures";

const RIGHT_CLICK = { x: 120, y: 150 };
const MENU_ITEM = { x: 170, y: 191 };
const FIRST_INPUT = { x: 110, y: 272 };

const CURSOR: readonly CursorStep[] = [
  { cue: "menu", at: RIGHT_CLICK },
  { cue: "menu", offset: 0.6, at: RIGHT_CLICK, click: true },
  { cue: "menu", offset: 1.1, at: MENU_ITEM },
  { cue: "menu", offset: 1.8, at: MENU_ITEM, click: true },
  { cue: "type", at: FIRST_INPUT },
  { cue: "type", offset: 0.6, at: FIRST_INPUT, click: true },
];

function ContextMenu({ visible }: { visible: boolean }) {
  return (
    <div
      className={cn(
        "absolute left-[126px] top-[158px] z-10 w-[150px] rounded-lg border border-border-strong bg-surface-panel-elevated p-1 shadow-[var(--theme-shadow-ambient)]",
        reveal(visible, "none")
      )}
    >
      <div className="flex items-center gap-2 rounded-md px-2 py-1 text-2xs text-text-secondary">
        <Copy className="size-3" aria-hidden="true" />
        Copy
      </div>
      <div className="flex items-center gap-2 rounded-md bg-overlay-selected px-2 py-1 text-2xs text-text-primary">
        <RadioTower className="size-3" aria-hidden="true" />
        Add to fleet
      </div>
      <div className="flex items-center gap-2 rounded-md px-2 py-1 text-2xs text-text-secondary">
        <X className="size-3" aria-hidden="true" />
        Close session
      </div>
    </div>
  );
}

export function FleetScene() {
  const menuShown = useCue("menu", 0.7);
  const firstArmed = useCue("menu", 1.9);
  const menuOpen = menuShown && !firstArmed;
  const allArmed = useCue("armed");
  const sent = useCue("send");
  const cursor = useMockCursor({ x: 330, y: 340 }, CURSOR);

  return (
    <div className="relative size-full">
      <div
        className={cn(
          "absolute left-[40px] top-[10px] flex h-7 items-center gap-2 rounded-full border border-border-strong bg-surface-panel px-3",
          reveal(allArmed, "above")
        )}
      >
        <RadioTower className="size-3 text-category-amber-text" aria-hidden="true" />
        <span className="text-2xs font-medium text-text-primary">3 in fleet</span>
      </div>

      {PANES.map((agent, i) => {
        const armed = i === 0 ? firstArmed : allArmed;
        const mirrored = !sent && i > 0 && allArmed;
        return (
          <div
            key={agent}
            className="absolute top-[48px] flex h-[240px] w-[175px]"
            style={{ left: PANE_LEFT[i] }}
          >
            <MockPane
              agent={agent}
              armed={armed}
              state={sent ? "working" : null}
              focused={i === 0 && armed}
              className="w-full"
              input={
                sent ? null : i === 0 ? (
                  <MockTyping cue="type" text={PROMPT} delay={0.5} charsPerSecond={30} />
                ) : mirrored ? (
                  <span className="text-text-secondary">
                    <MockTyping
                      cue="type"
                      text={PROMPT}
                      delay={0.5}
                      charsPerSecond={30}
                      caret={false}
                    />
                  </span>
                ) : null
              }
            >
              <MockStreamingLines
                cue="send"
                delay={0.3 + i * 0.15}
                widths={[86, 64, 92, 58, 76]}
                perSecond={3}
              />
            </MockPane>
          </div>
        );
      })}

      <ContextMenu visible={menuOpen} />
      <MockCursor {...cursor} />
    </div>
  );
}
