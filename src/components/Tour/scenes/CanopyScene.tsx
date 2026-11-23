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

// The Canopy window, over the app it reads: the inbox on the left, the
// selected run on the right.
const WINDOW = { x: 40, y: 38, width: 560, height: 296 } as const;
const LIST_WIDTH = 250;

const TELESCOPE = { anchor: "canopy" };
const TURN_ON = { anchor: "canopy-turn-on" };
const HOSTS = { anchor: "canopy-hosts" };
const ALL_HOSTS = { anchor: "canopy-all-hosts" };
const SDK_ROW = { anchor: "canopy-row-sdk" };
const ASKING_ROW = { anchor: "canopy-row-asking" };
const ALLOW = { anchor: "canopy-allow" };

export const CURSOR: readonly CursorStep[] = [
  { cue: "telescope", at: TELESCOPE },
  { cue: "telescope", offset: 0.5, at: TELESCOPE, click: true },
  { cue: "enable", offset: -0.4, at: TURN_ON },
  { cue: "enable", offset: 0.2, at: TURN_ON, click: true },
  { cue: "local", at: { x: 330, y: 300 } },
  { cue: "machines", offset: -0.3, at: HOSTS },
  { cue: "machines", offset: 0.1, at: HOSTS, click: true },
  { cue: "machines", offset: 0.5, at: ALL_HOSTS },
  { cue: "machines", offset: 0.8, at: ALL_HOSTS, click: true },
  // A row opens its run on the right: its progress, its screen, its choices.
  { cue: "progress", offset: -0.4, at: SDK_ROW },
  { cue: "progress", at: SDK_ROW, click: true },
  { cue: "answer", offset: -0.4, at: ASKING_ROW },
  { cue: "answer", at: ASKING_ROW, click: true },
  { cue: "answer", offset: 0.5, at: ALLOW },
  { cue: "answer", offset: 0.9, at: ALLOW, click: true },
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

function Row({
  run,
  selected,
  quiet,
  answered,
}: {
  run: Run;
  selected: boolean;
  quiet?: boolean;
  answered?: boolean;
}) {
  const status = answered ? "Installing packages" : run.status;
  return (
    <div
      data-tour-anchor={`canopy-row-${run.id}`}
      className={cn(
        "flex h-[30px] shrink-0 items-center gap-2 rounded-md px-2 transition-colors duration-150 ease-out",
        selected ? "bg-overlay-selected" : "bg-transparent"
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">
        <MockStateGlyph state={answered ? "working" : run.state} />
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
        <span className="flex min-w-0 items-center gap-1 text-3xs text-text-secondary">
          <span className="truncate">{status}</span>
          {/* A quiet run stays in the list; the row says so after its status. */}
          {quiet && (
            <span
              data-tour-anchor="canopy-quiet"
              className="flex shrink-0 items-center gap-0.5 text-text-primary"
            >
              <Hourglass className="size-2.5" aria-hidden="true" />
              Quiet
            </span>
          )}
        </span>
      </div>
      <span className="w-6 shrink-0 text-right text-3xs tabular-nums text-text-secondary">
        {run.age}
      </span>
    </div>
  );
}

/** The selected run: how far through it is, its screen, and the answers it's asking for. */
function Detail({
  run,
  progressed,
  answered,
  answering,
}: {
  run: Run;
  progressed: boolean;
  answered: boolean;
  answering: boolean;
}) {
  const asking = run.state === "waiting" && !answered;
  const value = run.progress?.[progressed ? 1 : 0];
  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-border-subtle">
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2.5">
        <MockAgentIcon agent={run.agent} className="size-3" />
        <span className="truncate text-3xs font-medium text-text-primary">{run.title}</span>
        <span className="shrink-0 text-3xs text-text-secondary">
          {run.project}
          {run.host && ` · ${run.host}`}
        </span>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border-subtle px-2.5 text-3xs text-text-secondary">
        {value !== undefined && (
          <span
            data-tour-anchor="canopy-detail-progress"
            className="flex shrink-0 items-center gap-1.5 tabular-nums"
          >
            <span className="flex h-1 w-14 overflow-hidden rounded-full bg-overlay-medium">
              <span
                className="h-full rounded-full bg-text-secondary transition-[width] duration-500 ease-out"
                style={{ width: `${value}%` }}
              />
            </span>
            {value}%
          </span>
        )}
        <span className="truncate">{answered ? "Installing packages" : run.status}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5 font-mono">
        <MockLines widths={[72, 54, 86, 60]} />
        {run.state === "waiting" && (
          <span className="text-3xs text-text-primary">
            {answered ? "› Allow" : "Allow npm install? (1 Allow, 2 Deny)"}
          </span>
        )}
      </div>
      <div
        data-tour-anchor="canopy-choices"
        className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border-subtle px-2.5"
      >
        {asking &&
          ["Allow", "Deny"].map((choice, i) => (
            <span
              key={choice}
              data-tour-anchor={i === 0 ? "canopy-allow" : undefined}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-3xs transition-colors duration-150 ease-out",
                i === 0 && answering
                  ? "bg-text-primary text-text-inverse"
                  : "bg-overlay-subtle text-text-primary"
              )}
            >
              <span className="rounded-sm border border-border-default px-0.5 text-text-secondary">
                {i + 1}
              </span>
              {choice}
            </span>
          ))}
      </div>
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
        <span className="absolute left-1/2 top-5 z-10 flex w-[150px] -translate-x-1/2 flex-col rounded-md border border-border-strong bg-surface-panel-elevated p-1 shadow-[var(--theme-shadow-ambient)]">
          <span className="px-1.5 py-0.5 text-3xs font-medium text-text-secondary">
            Show agents on
          </span>
          <span
            data-tour-anchor="canopy-all-hosts"
            className="rounded-sm bg-overlay-selected px-1.5 py-0.5 text-3xs text-text-primary"
          >
            All hosts
          </span>
          <span className="my-0.5 h-px bg-border-subtle" />
          {/* Each host reads its own agents; build-box already has Canopy on. */}
          {[
            ["This computer", "3"],
            ["build-box", "1"],
          ].map(([host, count]) => (
            <span
              key={host}
              className="flex items-center justify-between px-1.5 py-0.5 text-3xs text-text-secondary"
            >
              {host}
              <span className="tabular-nums">{count}</span>
            </span>
          ))}
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
  const sdkPicked = useCue("progress", 0.1);
  const progressed = useCue("progress", 0.5);
  const quiet = useCue("quiet");
  const answer = useCue("answer");
  const askingPicked = useCue("answer", 0.1);
  const answering = useCue("answer", 0.9);
  const answered = useCue("answer", 1.1);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  // The permission request rises to the top; another host's run joins once the list covers it.
  const inbox: Run[] = permission ? [ASKING, SDK, SUITE] : [SDK, SUITE, ASKING];
  if (allHosts) inbox.splice(2, 0, REMOTE);
  const selected = askingPicked ? ASKING : sdkPicked ? SDK : inbox[0]!;

  const spotlight: string[] = !telescope
    ? []
    : !open
      ? ["canopy"]
      : enable && !turnedOn
        ? ["canopy-turn-on"]
        : answered
          ? ["canopy-row-asking"]
          : askingPicked
            ? ["canopy-allow"]
            : answer
              ? ["canopy-row-asking"]
              : quiet
                ? ["canopy-quiet"]
                : sdkPicked
                  ? ["canopy-detail-progress"]
                  : progress
                    ? []
                    : allHosts
                      ? ["canopy-row-remote"]
                      : machines
                        ? menuOpen
                          ? []
                          : ["canopy-hosts"]
                        : permission
                          ? ["canopy-row-asking"]
                          : local && turnedOn
                            ? ["canopy-local"]
                            : [];

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
              <span className="absolute left-1/2 z-10 -translate-x-1/2">
                <HostPicker allHosts={allHosts} menuOpen={menuOpen && !allHosts} />
              </span>
            )}
          </div>
          {turnedOn ? (
            <div className="flex min-h-0 flex-1">
              <div className="flex shrink-0 flex-col" style={{ width: LIST_WIDTH }}>
                <span className="flex h-5 shrink-0 items-center gap-1.5 px-2.5 text-3xs font-semibold text-text-secondary">
                  Inbox <span className="font-normal tabular-nums">{inbox.length}</span>
                </span>
                <div className="flex flex-col gap-0.5 px-1">
                  {inbox.map((run) => (
                    <Row
                      key={run.id}
                      run={run}
                      selected={run === selected}
                      quiet={run === SUITE && quiet}
                      answered={run === ASKING && answered}
                    />
                  ))}
                </div>
                <span className="flex-1" />
                {/* Each machine reads its own agents; this one's are read here. */}
                <span
                  data-tour-anchor="canopy-local"
                  className="flex min-h-6 shrink-0 items-center gap-1.5 border-t border-border-subtle px-2.5 py-1 text-3xs text-text-secondary"
                >
                  <HardDrive className="size-2.5 shrink-0" aria-hidden="true" />
                  {allHosts
                    ? "Each host reads its own agents: this computer here, build-box on build-box"
                    : "Read on this computer, by a small model that comes with Daintree"}
                </span>
              </div>
              <Detail
                run={selected}
                progressed={progressed}
                answered={selected === ASKING && answered}
                answering={selected === ASKING && answering}
              />
            </div>
          ) : (
            <Pitch />
          )}
        </div>
      }
    >
      <MockSpotlight targets={spotlight} visible={spotlight.length > 0} />
      {/* The answer closes the ask, and the pointer's work with it. */}
      <MockCursor {...cursor} visible={cursor.visible && !answered} />
    </MockApp>
  );
}
