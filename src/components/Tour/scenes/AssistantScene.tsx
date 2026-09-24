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
const REQUEST = "Start issue #52 with Codex";
const ASKED = { cue: "act" } as const;
// The idle panel's Start assistant button; measured from the render.
const START_BUTTON = { x: 552, y: 250 };

const CURSOR: readonly CursorStep[] = [
  { cue: "open", at: BUTTON },
  { cue: "open", offset: 0.5, at: BUTTON, click: true },
  { cue: "start", offset: -0.2, at: START_BUTTON },
  { cue: "start", offset: 0.4, at: START_BUTTON, click: true },
];

/** One thing the Assistant did, as a line of its terminal transcript. */
function Step({ children, visible }: { children: string; visible: boolean }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-3xs", reveal(visible))}>
      <span className="shrink-0 text-text-secondary">▸</span>
      <span className="truncate text-text-primary">{children}</span>
    </div>
  );
}

/** Opening the panel doesn't start a session; the user starts it. */
function IdlePanel() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3 text-center">
      <DaintreeIcon className="size-5 text-text-secondary" />
      <span className="text-3xs text-text-secondary">
        Use Daintree Assistant to configure and navigate Daintree.
      </span>
      <span
        data-tour-anchor="assistant-start"
        className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse"
      >
        Start assistant
      </span>
    </div>
  );
}

function AssistantPanel({
  started,
  ask,
  act,
  tell,
}: {
  started: boolean;
  ask: boolean;
  act: boolean;
  tell: boolean;
}) {
  const created = useCue("act", 0.4);
  const launched = useCue("act", 1.1);
  const prompted = useCue("act", 1.9);
  return (
    <div className="flex size-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2">
        <DaintreeIcon className="size-3 text-text-primary" />
        <span className="text-2xs font-semibold text-text-primary">Daintree Assistant</span>
      </div>
      {started ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2 font-mono">
            <div className={cn("truncate text-3xs text-text-primary", reveal(act, "none"))}>
              › {REQUEST}
            </div>
            <div className="flex flex-col gap-1">
              <Step visible={created}>Created worktree issue-52</Step>
              <Step visible={launched}>Started Codex in it</Step>
              <Step visible={prompted}>Sent it issue #52</Step>
            </div>
            <span className={cn("text-3xs text-text-primary", reveal(tell))}>
              Codex needs you in issue-52: round each line, or the total?
            </span>
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
              <ClaudeIcon className="size-2.5" />
              Claude
            </div>
          </div>
        </>
      ) : (
        <IdlePanel />
      )}
    </div>
  );
}

export function AssistantScene() {
  const openCue = useCue("open");
  const open = useCue("open", 0.6);
  const started = useCue("start", 0.8);
  const ask = useCue("ask");
  const act = useCue("act");
  const created = useCue("act", 0.4);
  const launched = useCue("act", 1.1);
  const waiting = useCue("watch", 0.6);
  const tell = useCue("tell", 0.3);
  const runs = useCue("runs");
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch={created ? "issue-52" : "main"}
      focus={open ? ["right", "sidebar", "grid"] : openCue ? ["toolbar"] : ["grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" selected={!created} />
          <MockWorktreeCard name="add-search" branch="add-search" states={["completed"]} />
          <MockWorktreeCard
            name="issue-52"
            issueTitle="Checkout total rounds wrong"
            branch="feature/issue-52-checkout-total"
            selected={created}
            states={launched ? [waiting ? "waiting" : "working"] : []}
            className={reveal(created, "left")}
          />
        </>
      }
      grid={
        launched ? (
          <MockGrid columns={1}>
            <MockPane agent="codex" state={waiting ? "waiting" : "working"}>
              <MockStreamingLines
                cue="act"
                delay={1.9}
                widths={[80, 56, 90, 64, 72]}
                perSecond={3}
              />
            </MockPane>
          </MockGrid>
        ) : (
          <MockGrid columns={1}>
            <MockPane agent="claude" state="working">
              <MockLines widths={[70, 54, 82, 66]} />
            </MockPane>
          </MockGrid>
        )
      }
      rightPanel={
        open ? <AssistantPanel started={started} ask={ask} act={act} tell={tell} /> : undefined
      }
      dock={<MockWaitingPill count={1} className={reveal(waiting, "none")} />}
    >
      <MockSpotlight
        targets={runs ? ["assistant-runs-on"] : ["assistant-start"]}
        visible={runs || (open && !started)}
      />
      <MockCursor {...cursor} visible={cursor.visible && !started} />
    </MockApp>
  );
}
