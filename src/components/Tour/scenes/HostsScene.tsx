import { Check, ChevronDown, Cloud, Laptop, LoaderCircle, Plus, Server } from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCallout,
  MockCursor,
  MockLines,
  MockMenu,
  MockSpotlight,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
} from "@daintreehq/tour/kit";
import {
  GRID_RECT,
  MockApp,
  MockGrid,
  MockPane,
  MockWorktreeCard,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const SETTINGS = { x: 120, y: 44, width: 400, height: 272 } as const;
const FORM = { x: GRID_RECT.x + 119, y: 70, width: 230 } as const;
// The host menu hangs under the chip, which sits just right of the canvas centre.
const HOST_MENU = { x: 330, y: 26, width: 150 } as const;
const PLACEMENT_MENU = { x: FORM.x + 14, y: FORM.y + 104, width: 200 } as const;
const SSH_TARGET = "you@build-box";
const NEW_BRANCH = "migrate-payments";

export const CURSOR: readonly CursorStep[] = [
  { cue: "settings", at: { anchor: "settings" } },
  { cue: "settings", offset: 0.4, at: { anchor: "settings" }, click: true },
  { cue: "hosts", at: { anchor: "settings-nav-hosts" } },
  { cue: "hosts", offset: 0.2, at: { anchor: "settings-nav-hosts" }, click: true },
  { cue: "add", at: { anchor: "add-host" } },
  { cue: "add", offset: 0.4, at: { anchor: "add-host" }, click: true },
  { cue: "ssh", offset: -0.4, at: { anchor: "add-host-target", dx: 30, dy: -3 } },
  { cue: "cloud", at: { anchor: "add-host-cloud" } },
  { cue: "cloud", offset: 0.4, at: { anchor: "add-host-cloud" }, click: true },
  { cue: "chip", at: { anchor: "host-chip" } },
  { cue: "pick", at: { anchor: "host-chip" }, click: true },
  { cue: "pick", offset: 0.6, at: { anchor: "host-menu-1" } },
  { cue: "pick", offset: 1.0, at: { anchor: "host-menu-1" }, click: true },
  { cue: "placement", offset: -2.2, at: { anchor: "sidebar-plus" } },
  { cue: "placement", offset: -1.8, at: { anchor: "sidebar-plus" }, click: true },
  { cue: "placement", at: { anchor: "placement-host" } },
  { cue: "placement", offset: 0.3, at: { anchor: "placement-host" }, click: true },
  { cue: "fresh", at: { anchor: "placement-option-3" } },
  { cue: "fresh", offset: 0.4, at: { anchor: "placement-option-3" }, click: true },
  { cue: "fresh", offset: 1.2, at: { anchor: "placement-create" } },
  { cue: "fresh", offset: 1.6, at: { anchor: "placement-create" }, click: true },
];

/** One step of the add-host run, as the real dialog's checklist. */
function InstallStep({ label, state }: { label: string; state: "todo" | "running" | "done" }) {
  return (
    <span className="flex items-center gap-1 text-3xs text-text-secondary">
      {state === "done" ? (
        <Check className="size-2.5 text-status-success" aria-hidden="true" />
      ) : state === "running" ? (
        <LoaderCircle
          className="size-2.5 animate-spin-slow motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <span className="size-2.5 rounded-full border border-border-strong" />
      )}
      <span className={state === "todo" ? undefined : "text-text-primary"}>{label}</span>
    </span>
  );
}

function SettingsDialog({ open }: { open: boolean }) {
  const hostsPage = useCue("hosts", 0.3);
  const adding = useCue("add", 0.6);
  const checked = useCue("install");
  const installed = useCue("install", 1.4);
  const cloud = useCue("cloud", 0.6);
  const provisioning = useCue("provision");
  const provisioned = useCue("provision", 1.6);
  const step = (at: boolean, done: boolean) => (done ? "done" : at ? "running" : "todo");

  return (
    <div
      className={cn(
        "absolute z-10 flex overflow-hidden rounded-lg border border-border-strong bg-surface-dialog shadow-[var(--theme-shadow-ambient)]",
        reveal(open)
      )}
      style={{
        left: SETTINGS.x,
        top: SETTINGS.y,
        width: SETTINGS.width,
        height: SETTINGS.height,
      }}
    >
      <div className="flex w-[92px] shrink-0 flex-col gap-0.5 border-r border-border-subtle bg-surface-sidebar p-1.5">
        <span className="mb-1 px-1.5 text-2xs font-semibold text-text-primary">Settings</span>
        {["General", "Agents", "Hosts", "Decisions", "Keyboard"].map((name) => (
          <span
            key={name}
            data-tour-anchor={name === "Hosts" ? "settings-nav-hosts" : undefined}
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-3xs transition-colors duration-150 ease-out",
              name === "Hosts" && hostsPage
                ? "bg-overlay-selected text-text-primary"
                : name === "General" && !hostsPage
                  ? "bg-overlay-selected text-text-primary"
                  : "text-text-secondary"
            )}
          >
            {name}
          </span>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <div className={cn("absolute inset-0 flex flex-col gap-2 p-3", reveal(!hostsPage, "none"))}>
          <span className="text-xs font-semibold text-text-primary">General</span>
          <MockLines widths={[70, 50, 82, 64]} />
        </div>
        <div className={cn("absolute inset-0 flex flex-col gap-2 p-3", reveal(hostsPage, "none"))}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-primary">Remote hosts</span>
            <span
              data-tour-anchor="add-host"
              className="flex items-center gap-1 rounded-md bg-text-primary px-2 py-0.5 text-3xs font-medium text-text-inverse"
            >
              <Plus className="size-2.5" aria-hidden="true" />
              Add host
            </span>
          </div>
          <div className={cn("flex flex-col gap-1.5", reveal(adding))}>
            <span className="text-3xs font-medium text-text-secondary">
              A Mac or Linux machine over SSH
            </span>
            <div
              data-tour-anchor="add-host-target"
              className="flex h-5 items-center gap-1.5 rounded-md border border-border-interactive bg-surface-input px-2 text-3xs text-text-primary"
            >
              <Server className="size-2.5 text-text-secondary" aria-hidden="true" />
              <MockTyping
                cue="ssh"
                text={SSH_TARGET}
                delay={0.2}
                charsPerSecond={16}
                finishBy={{ cue: "install" }}
              />
            </div>
            <div className="flex items-center gap-2.5 pl-0.5">
              <InstallStep label="Find" state={step(checked, checked)} />
              <InstallStep label="Check" state={step(checked, installed)} />
              <InstallStep label="Install" state={step(checked, installed)} />
              <InstallStep label="Connect" state={step(installed, installed)} />
            </div>
          </div>
          <div className={cn("mt-1 flex flex-col gap-1.5", reveal(adding))}>
            <span className="text-3xs font-medium text-text-secondary">Or a cloud account</span>
            <div className="flex gap-1.5">
              {["DigitalOcean", "AWS", "Google Cloud"].map((provider, i) => (
                <span
                  key={provider}
                  data-tour-anchor={i === 0 ? "add-host-cloud" : undefined}
                  className={cn(
                    "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-3xs transition-colors duration-150 ease-out",
                    i === 0 && cloud
                      ? "border-border-interactive bg-overlay-selected text-text-primary"
                      : "border-border-subtle text-text-secondary"
                  )}
                >
                  <Cloud className="size-2.5" aria-hidden="true" />
                  {provider}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {(
              [
                ["build-box", "SSH · Linux", installed],
                ["gpu-runner", "DigitalOcean · Personal", provisioning],
              ] as const
            ).map(([name, detail, shown], i) => (
              <div
                key={name}
                data-tour-anchor={i === 1 ? "host-row-cloud" : "host-row-ssh"}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-border-subtle px-2 py-1",
                  reveal(shown, "none")
                )}
              >
                <Server className="size-3 text-text-secondary" aria-hidden="true" />
                <span className="text-2xs font-medium text-text-primary">{name}</span>
                <span className="text-3xs text-text-secondary">{detail}</span>
                <span className="flex-1" />
                <span className="text-3xs text-text-secondary">
                  {i === 1 && !provisioned ? "Creating…" : "Connected"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function HostChip({ host, open }: { host: string; open: boolean }) {
  return (
    <span
      data-tour-anchor="host-chip"
      className={cn(
        "ml-1 flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-3xs text-text-primary transition-colors duration-150 ease-out",
        open ? "border-border-interactive" : "border-border-subtle"
      )}
    >
      <Server className="size-2.5 text-text-secondary" aria-hidden="true" />
      {host}
      <ChevronDown className="size-2.5 text-text-secondary" aria-hidden="true" />
    </span>
  );
}

function CreateForm({
  open,
  choosing,
  fresh,
}: {
  open: boolean;
  choosing: boolean;
  fresh: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute z-10 rounded-lg border border-border-strong bg-surface-dialog p-3.5 shadow-[var(--theme-shadow-ambient)]",
        reveal(open)
      )}
      style={{ left: FORM.x, top: FORM.y, width: FORM.width }}
    >
      <div className="mb-2.5 text-xs font-semibold text-text-primary">Create worktree</div>
      <div className="mb-2 flex flex-col gap-1">
        <span className="text-3xs font-medium text-text-secondary">Name</span>
        <div className="flex h-5 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs text-text-primary">
          {NEW_BRANCH}
        </div>
      </div>
      <div className="mb-3 flex flex-col gap-1">
        <span className="text-3xs font-medium text-text-secondary">Host</span>
        <div
          data-tour-anchor="placement-host"
          className={cn(
            "flex h-5 items-center gap-1.5 rounded-md border bg-surface-input px-2 text-3xs text-text-primary",
            choosing ? "border-border-interactive" : "border-border-input"
          )}
        >
          {fresh ? (
            <Cloud className="size-2.5 text-text-secondary" aria-hidden="true" />
          ) : (
            <Server className="size-2.5 text-text-secondary" aria-hidden="true" />
          )}
          <span className="flex-1">{fresh ? "New machine · Personal" : "build-box"}</span>
          <ChevronDown className="size-2.5 text-text-secondary" aria-hidden="true" />
        </div>
      </div>
      <div className="flex justify-end">
        <span
          data-tour-anchor="placement-create"
          className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse"
        >
          Create worktree
        </span>
      </div>
    </div>
  );
}

export function HostsScene() {
  const settingsOpen = useCue("settings", 0.6);
  const hostsCue = useCue("hosts");
  const sshCue = useCue("ssh");
  const cloudCue = useCue("cloud");
  const chip = useCue("chip");
  const settingsClosed = useCue("chip", -0.4);
  const hostMenu = useCue("pick", 0.2);
  const picked = useCue("pick", 1.1);
  const switched = useCue("switch");
  const formOpen = useCue("placement", -1.6);
  const choosing = useCue("placement", 0.4);
  const freshCue = useCue("fresh");
  const fresh = useCue("fresh", 0.5);
  const created = useCue("fresh", 1.7);
  const running = useCue("running");
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  const provisionCue = useCue("provision");
  const away = useCue("running", 0.6);
  const onRemote = switched;
  const branch = created ? NEW_BRANCH : "main";
  const settings = settingsOpen && !settingsClosed;
  const placing = formOpen && !created;

  const focus = settings || placing ? [] : chip && !switched ? ["toolbar"] : undefined;

  const spotlight = running
    ? [`worktree-${NEW_BRANCH}`]
    : freshCue && !created
      ? ["placement-option-3"]
      : switched && !formOpen
        ? ["host-chip", "worktree-list"]
        : chip && !hostMenu
          ? ["host-chip"]
          : provisionCue
            ? ["host-row-cloud"]
            : cloudCue
              ? ["add-host-cloud"]
              : sshCue
                ? ["add-host-target"]
                : hostsCue && settings
                  ? ["settings-nav-hosts"]
                  : [];

  return (
    <MockApp
      branch={branch}
      focus={focus}
      hostChip={
        chip ? (
          <HostChip host={onRemote ? "build-box" : "This Mac"} open={hostMenu && !picked} />
        ) : undefined
      }
      worktrees={
        onRemote ? (
          <>
            <MockWorktreeCard name="shop-app" branch="main" selected={!created} />
            <MockWorktreeCard name="load-test" branch="load-test" states={["working"]} />
            <MockWorktreeCard
              name={NEW_BRANCH}
              branch={NEW_BRANCH}
              selected={created}
              states={running ? ["working"] : []}
              className={reveal(created, "left")}
            />
          </>
        ) : (
          <>
            <MockWorktreeCard name="shop-app" branch="main" selected />
            <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
            <MockWorktreeCard name="add-search" branch="add-search" />
          </>
        )
      }
      grid={
        created ? (
          <MockGrid columns={1}>
            <MockPane agent="codex" state="working" focused={running}>
              <MockStreamingLines cue="running" widths={[80, 56, 90, 64, 72, 50]} perSecond={2} />
            </MockPane>
          </MockGrid>
        ) : (
          <MockGrid columns={2}>
            <MockPane agent="claude" state="working">
              <MockLines widths={[84, 62, 90, 50]} />
            </MockPane>
            <MockPane agent="codex" state={onRemote ? "working" : "waiting"}>
              <MockLines widths={[72, 88, 58]} />
            </MockPane>
          </MockGrid>
        )
      }
      overlay={
        <>
          <SettingsDialog open={settings} />
          <CreateForm open={placing} choosing={choosing} fresh={fresh} />
        </>
      }
    >
      <MockMenu
        anchor="host-menu"
        visible={hostMenu && !picked}
        active={1}
        x={HOST_MENU.x}
        y={HOST_MENU.y}
        width={HOST_MENU.width}
        items={[
          { icon: <Check />, label: "This Mac" },
          { icon: <Server />, label: "build-box" },
          { icon: <Server />, label: "gpu-runner", muted: true },
          { icon: <Plus />, label: "Add host…", muted: true, separator: true },
        ]}
      />
      <MockMenu
        anchor="placement-option"
        visible={choosing && !created}
        active={fresh || freshCue ? 3 : 1}
        x={PLACEMENT_MENU.x}
        y={PLACEMENT_MENU.y}
        width={PLACEMENT_MENU.width}
        items={[
          { icon: <Laptop />, label: "This Mac", muted: true },
          { icon: <Server />, label: "build-box" },
          { icon: <Server />, label: "gpu-runner", muted: true },
          { icon: <Cloud />, label: "New machine · Personal", separator: true },
        ]}
      />
      <MockCallout x={GRID_RECT.x + GRID_RECT.width - 4} y={GRID_RECT.y + 30} visible={away}>
        On a new machine · keeps going while this Mac sleeps
      </MockCallout>
      <MockSpotlight targets={spotlight} visible={spotlight.length > 0} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
