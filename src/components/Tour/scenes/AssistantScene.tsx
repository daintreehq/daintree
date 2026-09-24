import { Check } from "lucide-react";
import { ClaudeIcon, DaintreeIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { ANCHOR, MockApp, MockGrid, MockWaitingPill, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockSpotlight } from "./sceneParts";

const BUTTON = ANCHOR.assistant;
const REQUEST = "Start issue #52 in its own worktree with Codex";
const ASKED = { cue: "act" } as const;

const CURSOR: readonly CursorStep[] = [
  { cue: "open", at: BUTTON },
  { cue: "open", offset: 0.5, at: BUTTON, click: true },
];

/** One thing the Assistant did, said the way a person would say it. */
function Step({ children, visible }: { children: string; visible: boolean }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-3xs", reveal(visible))}>
      <Check className="size-2.5 shrink-0 text-text-secondary" aria-hidden="true" />
      <span className="truncate text-text-primary">{children}</span>
    </div>
  );
}

function AssistantPanel({ ask, act, watch }: { ask: boolean; act: boolean; watch: boolean }) {
  const launched = useCue("act", 0.8);
  const prompted = useCue("act", 1.6);
  return (
    <div className="flex size-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2">
        <DaintreeIcon className="size-3 text-text-primary" />
        <span className="text-2xs font-semibold text-text-primary">Daintree Assistant</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
        <div
          className={cn(
            "self-end rounded-md bg-overlay-selected px-2 py-1 text-3xs text-text-primary",
            reveal(act)
          )}
        >
          {REQUEST}
        </div>
        <div className="flex flex-col gap-1">
          <Step visible={act}>Created worktree issue-52-checkout-total</Step>
          <Step visible={launched}>Started Codex in it</Step>
          <Step visible={prompted}>Sent it issue #52</Step>
        </div>
        <div className={cn("flex flex-col gap-1", reveal(watch))}>
          <span className="text-3xs text-text-primary">
            Codex is waiting on you in issue-52-checkout-total: should totals round per line, or
            once at the end?
          </span>
        </div>
      </div>
      <div className="shrink-0 border-t border-border-subtle p-1.5">
        <div className="flex h-5 items-center rounded-md border border-border-subtle bg-surface-input px-2 text-3xs">
          {ask && !act ? (
            <span className="truncate text-text-primary">
              <MockTyping cue="ask" text={REQUEST} delay={0.3} finishBy={ASKED} />
            </span>
          ) : (
            <span className="text-text-placeholder">Ask Claude</span>
          )}
        </div>
        <div
          data-tour-anchor="assistant-runs-on"
          className="mt-1 flex items-center gap-1 px-0.5 text-3xs text-text-secondary"
        >
          Using
          <ClaudeIcon className="size-2.5" />
          Claude
        </div>
      </div>
    </div>
  );
}

export function AssistantScene() {
  const open = useCue("open", 0.6);
  const ask = useCue("ask");
  const act = useCue("act");
  const launched = useCue("act", 0.8);
  const watch = useCue("watch", 0.6);
  const runs = useCue("runs");
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch={act ? "issue-52-checkout-total" : "main"}
      focus={open ? ["right", "sidebar", "grid"] : ["toolbar"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" selected={!act} />
          <MockWorktreeCard name="add-search" branch="add-search" states={["completed"]} />
          <MockWorktreeCard
            name="issue-52-checkout-total"
            branch="issue-52-checkout-total"
            selected={act}
            states={launched ? [watch ? "waiting" : "working"] : []}
            className={reveal(act, "left")}
          />
        </>
      }
      grid={
        launched ? (
          <MockGrid columns={1}>
            <MockPane agent="codex" state={watch ? "waiting" : "working"}>
              <MockStreamingLines
                cue="act"
                delay={1.8}
                widths={[80, 56, 90, 64, 72]}
                perSecond={3}
              />
            </MockPane>
          </MockGrid>
        ) : (
          <MockGrid columns={1}>
            <MockPane agent="claude" state="completed">
              <MockLines widths={[70, 54, 82]} />
            </MockPane>
          </MockGrid>
        )
      }
      rightPanel={open ? <AssistantPanel ask={ask} act={act} watch={watch} /> : undefined}
      dock={<MockWaitingPill count={1} className={reveal(watch, "none")} />}
    >
      <MockSpotlight targets={["assistant-runs-on"]} visible={runs} />
      <MockCursor {...cursor} visible={cursor.visible && !open} />
    </MockApp>
  );
}
