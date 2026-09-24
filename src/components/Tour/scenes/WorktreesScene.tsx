import { cn } from "@/lib/utils";
import {
  GRID_RECT,
  MockApp,
  MockGrid,
  MockWorktreeCard,
  SIDEBAR_PLUS_POINT,
} from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockEmptyGrid, MockSpotlight } from "./sceneParts";

const DIALOG = { x: GRID_RECT.x + 119, y: 84, width: 230 } as const;
const NAME_FIELD = { x: DIALOG.x + 120, y: DIALOG.y + 114 };
// Measured from the render: the dialog's Create worktree button.
const CREATE_BUTTON = { x: DIALOG.x + 164, y: DIALOG.y + 150 };
// The name is done before the pointer sets off for Create.
const CREATE = { cue: "create" } as const;

const CURSOR: readonly CursorStep[] = [
  { cue: "plus", at: SIDEBAR_PLUS_POINT },
  { cue: "plus", offset: 0.6, at: SIDEBAR_PLUS_POINT, click: true },
  { cue: "name", at: NAME_FIELD },
  { cue: "create", at: CREATE_BUTTON },
  { cue: "create", offset: 0.6, at: CREATE_BUTTON, click: true },
];

export function WorktreesScene() {
  const project = useCue("project");
  const list = useCue("list");
  const branchCue = useCue("branch");
  const dialogOpen = useCue("plus", 0.7);
  const created = useCue("create", 0.7);
  const cursor = useMockCursor({ x: 420, y: 300 }, CURSOR);

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
        <div
          className={cn(
            "absolute z-10 rounded-lg border border-border-strong bg-surface-dialog p-3.5 shadow-[var(--theme-shadow-ambient)]",
            reveal(dialogOpen && !created)
          )}
          style={{ left: DIALOG.x, top: DIALOG.y, width: DIALOG.width }}
        >
          <div className="mb-2.5 text-xs font-semibold text-text-primary">Create worktree</div>
          <div className="mb-2 flex flex-col gap-1">
            <span className="text-3xs font-medium text-text-secondary">Base</span>
            <div className="flex h-5 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs text-text-primary">
              main
            </div>
          </div>
          <div className="mb-3 flex flex-col gap-1">
            <span className="text-3xs font-medium text-text-secondary">Name</span>
            <div className="flex h-5 items-center rounded-md border border-border-interactive bg-surface-input px-2 text-3xs text-text-primary">
              <MockTyping
                cue="name"
                text="add-search"
                delay={0.4}
                charsPerSecond={14}
                finishBy={CREATE}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <span className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse">
              Create worktree
            </span>
          </div>
        </div>
      }
    >
      {/* "Its worktrees sit down the left" — the whole list, not one card. */}
      {/* Project, then the list, then one worktree's branch — each as it's named. */}
      <MockSpotlight
        targets={
          branchCue
            ? ["worktree-fix-login-redirect-branch"]
            : list
              ? ["worktree-list"]
              : ["project"]
        }
        visible={project && !dialogOpen}
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
