import {
  BellRing,
  ChevronDown,
  HardDrive,
  Hourglass,
  ListChecks,
  Monitor,
  Server,
  Telescope,
} from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockLines,
  MockSpotlight,
  reveal,
  useMockCursor,
} from "@daintreehq/tour/kit";
import {
  MockAgentIcon,
  type MockAgentId,
  MockApp,
  MockGrid,
  MockPane,
  MockStateGlyph,
  MockToolbarButton,
  MockWorktreeCard,
  type MockStateId,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

// The Canopy window, over the app it reads.
const WINDOW = { x: 56, y: 40, width: 528, height: 292 } as const;

const TELESCOPE = { anchor: "canopy" };
const TURN_ON = { anchor: "canopy-turn-on" };
const HOSTS = { anchor: "canopy-hosts" };
const ALL_HOSTS = { anchor: "canopy-all-hosts" };
const ALLOW = { anchor: "canopy-allow" };

export const CURSOR: readonly CursorStep[] = [
  { cue: "telescope", at: TELESCOPE },
  { cue: "telescope", offset: 0.5, at: TELESCOPE, click: true },
  { cue: "enable", offset: -0.4, at: TURN_ON },
  { cue: "enable", offset: 0.2, at: TURN_ON, click: true },
  { cue: "local", at: { x: 470, y: 300 } },
  { cue: "machines", offset: -0.3, at: HOSTS },
  { cue: "machines", offset: 0.1, at: HOSTS, click: true },
  { cue: "machines", offset: 0.5, at: ALL_HOSTS },
  { cue: "machines", offset: 0.8, at: ALL_HOSTS, click: true },
  { cue: "progress", at: { x: 470, y: 300 } },
  { cue: "answer", offset: -0.2, at: ALLOW },
  { cue: "answer", offset: 0.4, at: ALLOW, click: true },
];

interface Run {
  id: string;
  agent: MockAgentId;
  title: string;
  project: string;
  /** Another machine's run, shown once the list covers every host. */
  host?: string;
  state: MockStateId;
  status: string;
  /** How far through, as Canopy reads it; [before, after] the progress beat. */
  progress?: readonly [number, number];
  age: string;
}

const SDK: Run = {
  id: "sdk",
  agent: "codex",
  title: "Upgrade payments SDK",
  project: "shop-app",
  state: "working",
  status: "Updating call sites for the v18 API",
  progress: [35, 55],
  age: "4m",
};
const ASKING: Run = {
  id: "asking",
  agent: "claude",
  title: "Add search to the header",
  project: "shop-app",
  state: "waiting",
  status: "Allow npm install?",
  age: "now",
};
const SUITE: Run = {
  id: "suite",
  agent: "antigravity",
  title: "Rate limit the public API",
  project: "api-server",
  state: "working",
  status: "Running the integration suite",
  age: "12m",
};
const REMOTE: Run = {
  id: "remote",
  agent: "claude",
  title: "Migrate billing tables",
  project: "api-server",
  host: "build-box",
  state: "working",
  status: "Backfilling the invoices table",
  progress: [60, 70],
  age: "9m",
};

function ProgressBar({ id, value }: { id: string; value: number }) {
  return (
    <span
      data-tour-anchor={`canopy-progress-${id}`}
      className="flex h-1 w-14 shrink-0 overflow-hidden rounded-full bg-overlay-medium"
    >
      <span
        className="h-full rounded-full bg-text-secondary transition-[width] duration-500 ease-out"
        style={{ width: `${value}%` }}
      />
    </span>
  );
}

function Row({
  run,
  progressed,
  quiet,
  answered,
  answering,
}: {
  run: Run;
  progressed: boolean;
  quiet?: boolean;
  answered?: boolean;
  answering?: boolean;
}) {
  const asking = run.state === "waiting" && !answered;
  return (
    <div
      data-tour-anchor={`canopy-row-${run.id}`}
      className={cn(
        "flex h-[30px] shrink-0 items-center gap-2 rounded-md px-2 transition-colors duration-150 ease-out",
        asking ? "bg-overlay-subtle" : "bg-transparent"
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">
        {quiet ? (
          <Hourglass className="size-2.5 text-state-waiting" aria-hidden="true" />
        ) : (
          <MockStateGlyph state={answered ? "working" : run.state} />
        )}
      </span>
      <MockAgentIcon agent={run.agent} className="size-3" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-3xs font-medium text-text-primary">{run.title}</span>
          <span className="shrink-0 text-3xs text-text-secondary">
            {run.project}
            {run.host && ` · ${run.host}`}
          </span>
        </span>
        <span className="truncate text-3xs text-text-secondary">
          {quiet
            ? "No change on screen for 12 minutes"
            : answered
              ? "Installing packages"
              : run.status}
        </span>
      </div>
      {asking ? (
        <span className="flex shrink-0 items-center gap-1">
          <span
            data-tour-anchor="canopy-allow"
            className={cn(
              "rounded-md px-2 py-0.5 text-3xs font-medium transition-colors duration-150 ease-out",
              answering
                ? "bg-text-primary text-text-inverse"
                : "border border-border-default text-text-primary"
            )}
          >
            Allow
          </span>
          <span className="rounded-md border border-border-default px-2 py-0.5 text-3xs text-text-secondary">
            Deny
          </span>
        </span>
      ) : (
        run.progress && <ProgressBar id={run.id} value={run.progress[progressed ? 1 : 0]} />
      )}
      <span className="w-6 shrink-0 text-right text-3xs tabular-nums text-text-secondary">
        {run.age}
      </span>
    </div>
  );
}

/** The first-run offer: what Canopy does, and the one press that turns it on. */
function Pitch() {
  const points = [
    { icon: BellRing, title: "Permission prompts first" },
    { icon: ListChecks, title: "Where every run has got to" },
    { icon: Hourglass, title: "The one that went quiet" },
  ];
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[170px] shrink-0 flex-col gap-2 border-r border-border-subtle p-2">
        <span className="text-3xs font-semibold text-text-secondary">Inbox · Demo</span>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full bg-overlay-strong" />
            <MockLines widths={[row % 2 ? 70 : 88]} className="flex-1" />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5 px-6">
        <span className="text-xs font-semibold text-text-primary">Every agent, read for you</span>
        <span className="text-3xs leading-4 text-text-secondary">
          One inbox for all your agents, most urgent first.
        </span>
        <div className="flex flex-col gap-1.5">
          {points.map(({ icon: Icon, title }) => (
            <span key={title} className="flex items-center gap-1.5 text-3xs text-text-primary">
              <Icon className="size-2.5 shrink-0 text-text-secondary" aria-hidden="true" />
              {title}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span
            data-tour-anchor="canopy-turn-on"
            className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse"
          >
            Turn on Canopy
          </span>
          <span className="rounded-md border border-border-default px-2.5 py-1 text-3xs text-text-secondary">
            Hide Canopy
          </span>
        </div>
      </div>
    </div>
  );
}

function HostPicker({ allHosts, menuOpen }: { allHosts: boolean; menuOpen: boolean }) {
  const Icon = allHosts ? Server : Monitor;
  return (
    <span className="relative">
      <span
        data-tour-anchor="canopy-hosts"
        className="flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-3xs text-text-primary"
      >
        <Icon className="size-2.5 text-text-secondary" aria-hidden="true" />
        {allHosts ? "All hosts" : "This computer"}
        <ChevronDown className="size-2.5 text-text-secondary" aria-hidden="true" />
      </span>
      {menuOpen && (
        <span className="absolute left-0 top-5 z-10 flex w-[120px] flex-col rounded-md border border-border-strong bg-surface-panel-elevated p-1 shadow-[var(--theme-shadow-ambient)]">
          {["This computer", "build-box"].map((host) => (
            <span key={host} className="px-1.5 py-0.5 text-3xs text-text-secondary">
              {host}
            </span>
          ))}
          <span
            data-tour-anchor="canopy-all-hosts"
            className="rounded-sm bg-overlay-selected px-1.5 py-0.5 text-3xs text-text-primary"
          >
            All hosts
          </span>
        </span>
      )}
    </span>
  );
}

export function CanopyScene() {
  const telescope = useCue("telescope");
  const open = useCue("telescope", 0.7);
  const enable = useCue("enable");
  const turnedOn = useCue("enable", 0.6);
  const local = useCue("local");
  const permission = useCue("permission");
  const machines = useCue("machines");
  const menuOpen = useCue("machines", 0.3);
  const allHosts = useCue("machines", 1.0);
  const progress = useCue("progress");
  const progressed = useCue("progress", 0.4);
  const quiet = useCue("quiet");
  const answer = useCue("answer");
  const answering = useCue("answer", 0.4);
  const answered = useCue("answer", 0.8);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  // The permission request rises to the top; the quiet run is pulled out below.
  const inbox: Run[] = permission ? [ASKING, SDK] : [SDK, SUITE, ASKING];
  if (permission && !quiet) inbox.push(SUITE);
  if (allHosts) inbox.splice(permission ? 2 : 3, 0, REMOTE);

  const spotlight = !open
    ? ["canopy"]
    : !turnedOn
      ? ["canopy-turn-on"]
      : answer
        ? [answered ? "canopy-row-asking" : "canopy-allow"]
        : quiet
          ? ["canopy-quiet"]
          : progress
            ? allHosts
              ? ["canopy-progress-sdk", "canopy-progress-remote"]
              : ["canopy-progress-sdk"]
            : machines
              ? ["canopy-hosts"]
              : permission
                ? ["canopy-row-asking"]
                : ["canopy-local"];
  const spotlightOn =
    (telescope && !open) ||
    (enable && !turnedOn) ||
    (local && turnedOn && !machines) ||
    (machines && !menuOpen) ||
    (progress && !answer) ||
    answer;

  return (
    <MockApp
      branch="add-search"
      focus={open ? [] : telescope ? ["toolbar"] : undefined}
      signals={
        <MockToolbarButton anchor="canopy">
          <Telescope aria-hidden="true" />
        </MockToolbarButton>
      }
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard
            name="fix-login-redirect"
            branch="fix-login-redirect"
            states={["working"]}
          />
          <MockWorktreeCard name="add-search" branch="add-search" selected states={["waiting"]} />
        </>
      }
      grid={
        <MockGrid columns={2}>
          <MockPane agent="claude" state="waiting">
            <MockLines widths={[80, 56, 90, 64]} />
          </MockPane>
          <MockPane agent="codex" state="working">
            <MockLines widths={[70, 84, 52, 76, 60]} />
          </MockPane>
        </MockGrid>
      }
      overlay={
        <div
          className={cn(
            "absolute z-20 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-dialog shadow-[var(--theme-shadow-ambient)]",
            reveal(open)
          )}
          style={{ left: WINDOW.x, top: WINDOW.y, width: WINDOW.width, height: WINDOW.height }}
        >
          <div className="relative flex h-7 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2.5">
            <Telescope className="size-3 text-text-primary" aria-hidden="true" />
            <span className="text-2xs font-semibold text-text-primary">Daintree Canopy</span>
            {turnedOn && (
              <span className="absolute left-1/2 -translate-x-1/2">
                <HostPicker allHosts={allHosts} menuOpen={menuOpen && !allHosts} />
              </span>
            )}
          </div>
          {turnedOn ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <span className="flex h-5 shrink-0 items-center gap-1.5 px-2.5 text-3xs font-semibold text-text-secondary">
                Inbox <span className="font-normal tabular-nums">{inbox.length}</span>
              </span>
              <div className="flex flex-col gap-0.5 px-1">
                {inbox.map((run) => (
                  <Row
                    key={run.id}
                    run={run}
                    progressed={progressed}
                    answered={run === ASKING && answered}
                    answering={run === ASKING && answering}
                  />
                ))}
              </div>
              <div
                data-tour-anchor="canopy-quiet"
                className={cn("mt-1 flex flex-col px-1", reveal(quiet, "none"))}
              >
                <span className="flex h-5 items-center gap-1.5 px-1.5 text-3xs font-semibold text-text-secondary">
                  Gone quiet
                </span>
                {quiet && <Row run={SUITE} progressed={progressed} quiet />}
              </div>
              <span className="flex-1" />
              <span
                data-tour-anchor="canopy-local"
                className="flex h-6 shrink-0 items-center gap-1.5 border-t border-border-subtle px-2.5 text-3xs text-text-secondary"
              >
                <HardDrive className="size-2.5" aria-hidden="true" />
                Read on this computer, by a small model that comes with Daintree
              </span>
            </div>
          ) : (
            <Pitch />
          )}
        </div>
      }
    >
      <MockSpotlight targets={spotlight} visible={spotlightOn} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
