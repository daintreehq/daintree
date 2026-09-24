import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { Avatar } from "@/components/ui/Avatar";
import { IssueTooltipContent } from "@/components/Worktree/WorktreeCard/ForgeTooltipContent";
import { AssignIssueToggle } from "@/components/Worktree/views/IssueSelectorView";
import type { ForgeUser, IssueTooltipData } from "@shared/types/forge";
import "@/index.css";

/**
 * Standalone visual-review harness for `Avatar` and every surface that renders
 * a forge avatar.
 *
 * Sections (each tagged `data-shot` for the capture spec):
 *   matrix       the primitive at every size a caller uses × every load state × both shapes
 *   hovercard-*  the REAL `IssueTooltipContent` (author + assignee avatars) on the overlay plane
 *   list-rail    the GitHub list row's assignee rail slot
 *   assign-row   the REAL `AssignIssueToggle` from the new-worktree dialog
 *
 * Avatar URLs point at `https://avatars.githubusercontent.com/<login>`; the
 * capture spec routes that host by login prefix: `ok-*` → a generated square
 * picture, `wide-*` → a 2:1 picture, `broken-*` → 404, `slow-*` → never answers.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

installPreviewShims();
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const url = (login: string) => `https://avatars.githubusercontent.com/${login}`;
const user = (login: string): ForgeUser => ({ login, avatarUrl: url(login), rawData: {} });

const SIZES = [
  { px: 12, cls: "w-3 h-3" },
  { px: 14, cls: "w-3.5 h-3.5" },
  { px: 16, cls: "w-4 h-4" },
  { px: 24, cls: "w-6 h-6" },
] as const;

const STATES = [
  { label: "Loaded", src: url("ok-avery") },
  { label: "Loading", src: url("slow-kim") },
  { label: "Failed", src: url("broken-sam") },
  { label: "No URL", src: "" },
  { label: "Non-square", src: url("wide-pat") },
] as const;

const CREATED = new Date(2026, 8, 2, 10, 30).getTime();

const ISSUE_BASE: IssueTooltipData = {
  number: 4821,
  title: "Stream upload retries ignore the server's Retry-After header",
  bodyExcerpt:
    "When the ingest API answers 429 the uploader backs off on a fixed 2s step instead of the Retry-After value.",
  state: "open",
  rawState: "OPEN",
  createdAt: CREATED,
  author: user("ok-avery"),
  assignees: [user("broken-sam")],
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "backend", color: "e99695" },
  ],
};

const ISSUE_MANY: IssueTooltipData = {
  ...ISSUE_BASE,
  author: user("broken-jo"),
  assignees: [user("ok-avery"), user("slow-kim"), user("broken-sam"), user("wide-pat")],
};

function Section({ shot, title, children }: { shot: string; title: string; children: ReactNode }) {
  return (
    <section data-shot={shot} className="p-4 space-y-3 w-fit">
      <h2 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

function Matrix() {
  return (
    <Section shot="matrix" title="Avatar — sizes × states × shapes">
      <div className="rounded-[var(--radius-md)] bg-surface-panel p-3">
        <table className="text-2xs text-text-secondary border-separate border-spacing-x-3 border-spacing-y-2">
          <thead>
            <tr>
              <th />
              {SIZES.map((s) => (
                <th key={s.px} colSpan={2} className="font-normal text-center">
                  {s.px}px
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STATES.map((state) => (
              <tr key={state.label}>
                <td className="pr-2 text-left">{state.label}</td>
                {SIZES.flatMap((s) =>
                  (["circle", "square"] as const).map((shape) => (
                    <td key={`${s.px}-${shape}`} className="align-middle">
                      <div className="flex items-center justify-center h-7 w-7">
                        <Avatar src={state.src} alt="" shape={shape} className={s.cls} />
                      </div>
                    </td>
                  ))
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** The hover card's own surface classes, held open statically. */
function OverlayCard({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-xs overflow-hidden rounded-[var(--radius-md)] surface-overlay shadow-overlay p-3 text-xs text-text-primary">
      {children}
    </div>
  );
}

/**
 * Copy of the GitHub list row's assignee rail slot (`RAIL_SLOT` +
 * `RESOURCE_RAIL_SLOT.assignee.box` in the github plugin) — harness decoration;
 * the Avatar inside it is the real one with the row's own props.
 */
function RailRow({ title, assignee }: { title: string; assignee: ForgeUser | null }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 w-[420px] text-xs text-text-primary">
      <span className="truncate flex-1">{title}</span>
      <span className={"shrink-0 flex items-center justify-center w-4"} data-rail-slot="assignee">
        {assignee && <Avatar src={assignee.avatarUrl ?? ""} alt="" className="w-4 h-4" />}
      </span>
    </div>
  );
}

function AssignRows() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  const [c, setC] = useState(false);
  const [d, setD] = useState(false);
  return (
    <div className="rounded-[var(--radius-md)] bg-surface-panel p-3 space-y-3">
      <AssignIssueToggle
        assignWorktreeToSelf={a}
        onSetAssignWorktreeToSelf={setA}
        currentUser="ok-avery"
        currentUserAvatar={url("ok-avery")}
      />
      <AssignIssueToggle
        assignWorktreeToSelf={b}
        onSetAssignWorktreeToSelf={setB}
        currentUser="broken-sam"
        currentUserAvatar={url("broken-sam")}
      />
      <AssignIssueToggle
        assignWorktreeToSelf={d}
        onSetAssignWorktreeToSelf={setD}
        currentUser="nourl-lee"
        currentUserAvatar={undefined}
      />
      <AssignIssueToggle
        assignWorktreeToSelf={c}
        onSetAssignWorktreeToSelf={setC}
        currentUser={undefined}
        currentUserAvatar={undefined}
      />
    </div>
  );
}

function Preview() {
  return (
    <div data-preview-shell className="flex flex-col gap-2 p-2 text-text-primary">
      <Matrix />
      <Section shot="hovercard-single" title="Issue hover card — author loaded, assignee failed">
        <OverlayCard>
          <IssueTooltipContent data={ISSUE_BASE} />
        </OverlayCard>
      </Section>
      <Section shot="hovercard-many" title="Issue hover card — author failed, four assignees">
        <OverlayCard>
          <IssueTooltipContent data={ISSUE_MANY} />
        </OverlayCard>
      </Section>
      <Section shot="list-rail" title="GitHub list row — assignee rail">
        <div className="rounded-[var(--radius-md)] bg-surface-panel divide-y divide-border-subtle">
          <RailRow title="Loaded picture" assignee={user("ok-avery")} />
          <RailRow title="Picture 404s" assignee={user("broken-sam")} />
          <RailRow title="Provider sent no avatar URL" assignee={{ login: "nourl", rawData: {} }} />
          <RailRow title="Still loading" assignee={user("slow-kim")} />
        </div>
      </Section>
      <Section shot="assign-row" title="New worktree — assign to me">
        <AssignRows />
      </Section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider
      delayDuration={UI_TOOLTIP_DELAY_DURATION}
      skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
    >
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
