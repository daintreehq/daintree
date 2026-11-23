import { ChevronDown } from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockLines,
  MockSpotlight,
  MockTyping,
  reveal,
  useMockCursor,
} from "@daintreehq/tour/kit";
import {
  GRID_RECT,
  MockAgentIcon,
  MockApp,
  MockEmptyGrid,
  MockGrid,
  MockPane,
  MockWorktreeCard,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const DIALOG = { x: GRID_RECT.x + 119, y: 64, width: 230 } as const;
const NAME_FIELD = { anchor: "create-worktree-name", dx: 5, dy: -3 };
const CREATE_BUTTON = { anchor: "create-worktree-button" };
const AGENT_FIELD = { anchor: "create-worktree-agent", dx: 30 };
const PROMPT_FIELD = { anchor: "create-worktree-prompt", dx: 20, dy: -6 };
// The name is done before the pointer sets off for Create.
const CREATE = { cue: "create" } as const;
const EMPTY = { cue: "empty" } as const;
const FIRST_TASK = "Add a search box to the header";

export const CURSOR: readonly CursorStep[] = [
  { cue: "plus", at: { anchor: "sidebar-plus" } },
  { cue: "plus", offset: 0.6, at: { anchor: "sidebar-plus" }, click: true },
  { cue: "name", at: NAME_FIELD },
  { cue: "create", at: CREATE_BUTTON },
  { cue: "create", offset: 0.6, at: CREATE_BUTTON, click: true },
  // The same form again, to show what else it can do.
  { cue: "agent", at: AGENT_FIELD },
  { cue: "agent", offset: 0.4, at: AGENT_FIELD, click: true },
  { cue: "prompt", at: PROMPT_FIELD },
  { cue: "empty", offset: -0.3, at: AGENT_FIELD },
  { cue: "empty", offset: 0.2, at: AGENT_FIELD, click: true },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex flex-col gap-1">
      <span className="text-3xs font-medium text-text-secondary">{label}</span>
      {children}
    </div>
  );
}

/**
 * The Create worktree form. The first time through it names a branch and
 * creates it; the second shows its Agent and Prompt rows, then sets the agent
 * back to "No agent" — the choice that leaves the new worktree empty.
 */
function CreateForm({
  visible,
  showcase,
  agentChosen,
}: {
  visible: boolean;
  /** The second visit, which shows the agent rows rather than naming a branch. */
  showcase: boolean;
  agentChosen: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute z-10 rounded-lg border border-border-strong bg-surface-dialog p-3.5 shadow-[var(--theme-shadow-ambient)]",
        reveal(visible)
      )}
      style={{ left: DIALOG.x, top: DIALOG.y, width: DIALOG.width }}
    >
      <div className="mb-2.5 text-xs font-semibold text-text-primary">Create worktree</div>
      <Row label="Base">
        <div className="flex h-5 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs text-text-primary">
          main
        </div>
      </Row>
      <Row label="Name">
        <div
          data-tour-anchor="create-worktree-name"
          className={cn(
            "flex h-5 items-center rounded-md border bg-surface-input px-2 text-3xs",
            showcase
              ? "border-border-input text-text-secondary"
              : "border-border-interactive text-text-primary"
          )}
        >
          {showcase ? (
            "Branch name"
          ) : (
            <MockTyping
              cue="name"
              text="add-search"
              delay={0.4}
              charsPerSecond={14}
              finishBy={CREATE}
            />
          )}
        </div>
      </Row>
      <Row label="Agent">
        <div
          data-tour-anchor="create-worktree-agent"
          className="flex h-5 items-center gap-1.5 rounded-md border border-border-input bg-surface-input px-2 text-3xs"
        >
          {agentChosen ? (
            <>
              <MockAgentIcon agent="claude" className="size-2.5" />
              <span className="text-text-primary">Claude</span>
            </>
          ) : (
            <span className="text-text-secondary">No agent</span>
          )}
          <span className="flex-1" />
          <ChevronDown className="size-2.5 text-text-secondary" aria-hidden="true" />
        </div>
      </Row>
      {/* The real form shows Prompt only once an agent is chosen. */}
      {agentChosen && (
        <Row label="Prompt">
          <div
            data-tour-anchor="create-worktree-prompt"
            className="flex h-9 items-start rounded-md border border-border-input bg-surface-input px-2 py-1 text-3xs text-text-primary"
          >
            <PromptText />
          </div>
        </Row>
      )}
      <div className="mt-3 flex justify-end">
        <span
          data-tour-anchor="create-worktree-button"
          className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse"
        >
          Create worktree
        </span>
      </div>
    </div>
  );
}

function PromptText() {
  const typing = useCue("prompt", 0.3);
  if (!typing)
    return <span className="text-text-secondary">First task for the agent (optional)</span>;
  return <MockTyping cue="prompt" text={FIRST_TASK} delay={0.3} finishBy={EMPTY} />;
}

export function WorktreesScene() {
  const project = useCue("project");
  const list = useCue("list");
  const branchCue = useCue("branch");
  const dialogOpen = useCue("plus", 0.7);
  const created = useCue("create", 0.7);
  const formCue = useCue("form");
  const agentCue = useCue("agent");
  const agentPicked = useCue("agent", 0.6);
  const promptCue = useCue("prompt");
  const emptyCue = useCue("empty");
  const noAgent = useCue("empty", 0.4);
  const showcaseClosed = useCue("empty", 1.4);
  const cursor = useMockCursor({ x: 420, y: 300 }, CURSOR);

  const showcase = formCue;
  const formVisible = showcase ? !showcaseClosed : dialogOpen && !created;

  const spotTargets = showcase
    ? promptCue && !emptyCue
      ? ["create-worktree-prompt"]
      : ["create-worktree-agent"]
    : branchCue
      ? ["worktree-fix-login-redirect-branch"]
      : list
        ? ["worktree-list"]
        : ["project"];
  const spotVisible = showcase ? agentCue && !showcaseClosed : project && !dialogOpen;

  return (
    <MockApp
      branch={created ? "add-search" : "main"}
      focus={created ? ["sidebar", "grid"] : list ? ["sidebar"] : ["toolbar", "sidebar"]}
      worktrees={
        <>
          <MockWorktreeCard
            name="shop-app"
            branch="main"
            selected={!created}
            states={["working", "working"]}
          />
          <MockWorktreeCard
            name="fix-login-redirect"
            branch="fix-login-redirect"
            states={["waiting"]}
          />
          <MockWorktreeCard
            name="add-search"
            branch="add-search"
            selected={created}
            className={reveal(created, "left")}
          />
        </>
      }
      grid={
        created ? (
          <MockEmptyGrid label="add-search" />
        ) : (
          <MockGrid columns={2}>
            <MockPane agent="claude" state="working">
              <MockLines widths={[84, 62, 90, 50, 70]} />
            </MockPane>
            <MockPane agent="codex" state="working">
              <MockLines widths={[72, 88, 58, 80]} />
            </MockPane>
          </MockGrid>
        )
      }
      overlay={
        <CreateForm
          visible={formVisible}
          showcase={showcase}
          agentChosen={showcase && agentPicked && !noAgent}
        />
      }
    >
      {/* Project, then the list, then one worktree's branch — each as it's named;
          then the form's Agent and Prompt rows. */}
      <MockSpotlight targets={spotTargets} visible={spotVisible} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
