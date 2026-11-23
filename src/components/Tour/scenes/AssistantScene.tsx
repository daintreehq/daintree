import { Laptop, Server } from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockLines,
  MockSpotlight,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
} from "@daintreehq/tour/kit";
import {
  MockApp,
  MockGrid,
  MockPane,
  MockWaitingPill,
  MockWorktreeCard,
  MockAgentGlyph,
  MockAppMark,
  MockStateGlyph,
  type MockStateId,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const BUTTON = { anchor: "assistant" };
const REQUEST = "Start issue #52 with Codex";
const ISSUE_BRANCH = "feature/issue-52-checkout-total";
const ASKED = { cue: "act" } as const;
const START_BUTTON = { anchor: "assistant-start" };
const GLOBAL_OPTION = { anchor: "assistant-scope-global" };

// What the global session reports: every project, and only the machines it's been allowed.
const PROJECTS: ReadonlyArray<{ name: string; state: MockStateId }> = [
  { name: "shop-app", state: "waiting" },
  { name: "api-server", state: "working" },
  { name: "docs-site", state: "completed" },
];
const MACHINES = [
  { name: "This Mac", Icon: Laptop },
  { name: "build-box", Icon: Server },
] as const;

export const CURSOR: readonly CursorStep[] = [
  { cue: "open", at: BUTTON },
  { cue: "open", offset: 0.5, at: BUTTON, click: true },
  { cue: "start", offset: -0.2, at: START_BUTTON },
  { cue: "start", offset: 0.4, at: START_BUTTON, click: true },
  { cue: "global", offset: -0.4, at: GLOBAL_OPTION },
  { cue: "global", offset: 0.1, at: GLOBAL_OPTION, click: true },
];

/** The panel's title is its scope switch, Project or Global, as the real header. */
function ScopeSwitch({ global }: { global: boolean }) {
  return (
    <span
      data-tour-anchor="assistant-scope"
      className="flex items-center rounded-md border border-border-subtle p-px text-3xs"
    >
      {(["Project", "Global"] as const).map((label) => {
        const on = (label === "Global") === global;
        return (
          <span
            key={label}
            data-tour-anchor={`assistant-scope-${label.toLowerCase()}`}
            className={cn(
              "rounded-sm px-1.5 py-px transition-colors duration-150 ease-out",
              on ? "bg-overlay-selected font-medium text-text-primary" : "text-text-secondary"
            )}
          >
            {label}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Global is its own session, not the project one widened: switching shows the
 * global assistant's own transcript, already running here. What it looks after
 * comes through what it says — every project, then the machines it may use.
 */
function GlobalSession({ projects, machines }: { projects: boolean; machines: boolean }) {
  return (
    <div
      data-tour-anchor="assistant-global-session"
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-2 font-mono"
    >
      <div className="text-3xs text-text-primary">› What needs me today?</div>
      <div className={cn("flex flex-col gap-0.5", reveal(projects))}>
        {PROJECTS.map((project) => (
          <span key={project.name} className="flex items-center gap-1.5 text-3xs text-text-primary">
            <span className="flex size-2.5 items-center justify-center [&_svg]:size-2.5">
              <MockStateGlyph state={project.state} />
            </span>
            {project.name}
          </span>
        ))}
      </div>
      <div
        data-tour-anchor="assistant-machines"
        className={cn("flex flex-col gap-0.5", reveal(machines))}
      >
        <span className="text-3xs text-text-secondary">Machines I can use:</span>
        {MACHINES.map(({ name, Icon }) => (
          <span key={name} className="flex items-center gap-1.5 text-3xs text-text-primary">
            <Icon className="size-2.5 text-text-secondary" aria-hidden="true" />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One thing the Assistant did, as a line of its terminal transcript. */
function Step({ children, visible }: { children: string; visible: boolean }) {
  return (
    <div className={cn("flex items-baseline gap-1.5 text-3xs", reveal(visible))}>
      <span className="shrink-0 text-text-secondary">▸</span>
      <span className="text-text-primary">{children}</span>
    </div>
  );
}

/** Opening the panel doesn't start a session; the user starts it. */
function IdlePanel() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3 text-center">
      <MockAppMark className="size-5 text-text-secondary" />
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
  global,
}: {
  started: boolean;
  ask: boolean;
  act: boolean;
  tell: boolean;
  global: boolean;
}) {
  const created = useCue("act", 0.4);
  const launched = useCue("act", 1.1);
  const prompted = useCue("act", 1.9);
  const projects = useCue("global", 0.6);
  const machines = useCue("machines");
  return (
    <div className="flex size-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2">
        <MockAppMark className="size-3 text-text-secondary" />
        <ScopeSwitch global={global} />
      </div>
      {started ? (
        <>
          {global ? (
            <GlobalSession projects={projects} machines={machines} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2 font-mono">
              <div className={cn("text-3xs text-text-primary", reveal(act, "none"))}>
                › {REQUEST}
              </div>
              <div className="flex flex-col gap-1">
                <Step visible={created}>Created worktree issue-52</Step>
                <Step visible={launched}>Started Codex in it</Step>
                <Step visible={prompted}>Sent it issue #52</Step>
              </div>
              <span
                data-tour-anchor="assistant-tell"
                className={cn("text-3xs text-text-primary", reveal(tell))}
              >
                Codex needs you in issue-52: round each line, or the total?
              </span>
            </div>
          )}
          <div className="shrink-0 border-t border-border-subtle p-1.5">
            <div className="flex h-5 items-center rounded-md border border-border-subtle bg-surface-input px-2 text-3xs">
              {ask && !act ? (
                <span className="truncate text-text-primary">
                  <MockTyping cue="ask" text={REQUEST} delay={0.3} finishBy={ASKED} />
                </span>
              ) : (
                <span className="text-text-secondary">Ask Claude</span>
              )}
            </div>
            <div
              data-tour-anchor="assistant-runs-on"
              className="mt-1 flex items-center gap-1 px-0.5 text-3xs text-text-secondary"
            >
              <MockAgentGlyph agent="claude" className="size-2.5" />
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
  const globalCue = useCue("global", -0.4);
  const global = useCue("global", 0.2);
  const machines = useCue("machines");
  const runs = useCue("runs");
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch={created ? ISSUE_BRANCH : "main"}
      focus={open ? ["right", "sidebar", "grid", "dock"] : openCue ? ["toolbar"] : ["grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" selected={!created} />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
          <MockWorktreeCard name="add-search" branch="add-search" states={["completed"]} />
          <MockWorktreeCard
            name="issue-52"
            issueTitle="Checkout total rounds wrong"
            branch={ISSUE_BRANCH}
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
        open ? (
          <AssistantPanel started={started} ask={ask} act={act} tell={tell} global={global} />
        ) : undefined
      }
      dock={<MockWaitingPill count={1} className={reveal(waiting, "none")} />}
    >
      <MockSpotlight
        targets={
          runs
            ? ["assistant-runs-on"]
            : machines
              ? ["assistant-machines"]
              : globalCue
                ? ["assistant-scope"]
                : tell
                  ? ["assistant-tell"]
                  : ["assistant-start"]
        }
        visible={runs || machines || (globalCue && !global) || tell || (open && !started)}
      />
      {/* Hidden while the Assistant works; back only to switch its scope. */}
      <MockCursor {...cursor} visible={cursor.visible && (!started || (globalCue && !machines))} />
    </MockApp>
  );
}
