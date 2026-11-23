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
  type AppRegion,
  GRID_RECT,
  MockApp,
  MockEmptyGrid,
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
// What a machine made for one worktree is called once it is up.
const NEW_MACHINE = "payments-box";

export const CURSOR: readonly CursorStep[] = [
  { cue: "settings", at: { anchor: "settings" } },
  { cue: "settings", offset: 0.4, at: { anchor: "settings" }, click: true },
  { cue: "hosts", at: { anchor: "settings-nav-hosts" } },
  { cue: "hosts", offset: 0.2, at: { anchor: "settings-nav-hosts" }, click: true },
  { cue: "add", at: { anchor: "add-host" } },
  { cue: "add", offset: 0.4, at: { anchor: "add-host" }, click: true },
  { cue: "ssh", offset: -0.4, at: { anchor: "add-host-target", dx: 30, dy: -3 } },
  // The real dialog does nothing with an address until Check host is pressed,
  // and a fresh host then takes Review install, Turn on Host mode and Connect,
  // each from the same footer button.
  { cue: "install", offset: -0.8, at: { anchor: "add-host-check" } },
  { cue: "install", offset: -0.3, at: { anchor: "add-host-check" }, click: true },
  { cue: "install", offset: 0.2, at: { anchor: "add-host-check" }, click: true },
  { cue: "install", offset: 0.65, at: { anchor: "add-host-check" }, click: true },
  { cue: "install", offset: 1.1, at: { anchor: "add-host-check" }, click: true },
  // The cloud is the other way in: Add host again, then its own entry.
  { cue: "cloud", offset: -0.9, at: { anchor: "add-host" } },
  { cue: "cloud", offset: -0.3, at: { anchor: "add-host" }, click: true },
  { cue: "cloud", offset: 0.2, at: { anchor: "add-host-cloud" } },
  { cue: "cloud", offset: 0.7, at: { anchor: "add-host-cloud" }, click: true },
  // With no account yet, the cloud dialog's first step is connecting one.
  { cue: "cloud", offset: 1.2, at: { anchor: "cloud-connect-account" } },
  { cue: "cloud", offset: 1.7, at: { anchor: "cloud-connect-account" }, click: true },
  { cue: "provision", offset: -0.7, at: { anchor: "cloud-create" } },
  { cue: "provision", offset: -0.2, at: { anchor: "cloud-create" }, click: true },
  { cue: "chip", at: { anchor: "host-chip" } },
  { cue: "pick", at: { anchor: "host-chip" }, click: true },
  { cue: "pick", offset: 0.6, at: { anchor: "host-menu-1" } },
  { cue: "pick", offset: 1.0, at: { anchor: "host-menu-1" }, click: true },
  // A new machine is only offered from this computer's window, so go back first.
  { cue: "placement", offset: -2.6, at: { anchor: "host-chip" } },
  { cue: "placement", offset: -2.1, at: { anchor: "host-chip" }, click: true },
  { cue: "placement", offset: -1.75, at: { anchor: "host-menu-0" } },
  { cue: "placement", offset: -1.3, at: { anchor: "host-menu-0" }, click: true },
  { cue: "placement", offset: -1.0, at: { anchor: "sidebar-plus" } },
  { cue: "placement", offset: -0.55, at: { anchor: "sidebar-plus" }, click: true },
  { cue: "placement", offset: 0.05, at: { anchor: "placement-host" } },
  { cue: "placement", offset: 0.5, at: { anchor: "placement-host" }, click: true },
  { cue: "fresh", offset: -0.3, at: { anchor: "placement-option-3" } },
  { cue: "fresh", offset: 0.2, at: { anchor: "placement-option-3" }, click: true },
  { cue: "fresh", offset: 0.6, at: { anchor: "placement-create" } },
  { cue: "fresh", offset: 1.1, at: { anchor: "placement-create" }, click: true },
  // A worktree made for a new machine starts no agent, so launch one there.
  { cue: "running", offset: -1.0, at: { anchor: "agent-codex" } },
  { cue: "running", offset: -0.5, at: { anchor: "agent-codex" }, click: true },
  // Rest on the new worktree once the form is gone, never on a control that left.
  { cue: "running", offset: 0.3, at: { anchor: `worktree-${NEW_BRANCH}` } },
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

function FooterButton({
  anchor,
  primary,
  children,
}: {
  anchor: string;
  primary?: boolean;
  children: string;
}) {
  return (
    <span
      data-tour-anchor={anchor}
      className={cn(
        "rounded-md px-2 py-0.5 text-3xs font-medium",
        primary
          ? "bg-text-primary text-text-inverse"
          : "border border-border-subtle text-text-secondary"
      )}
    >
      {children}
    </span>
  );
}

/** Add host over SSH, as the real dialog: an address, Check host, then its setup steps. */
function AddHostDialog({ open, again }: { open: boolean; again: boolean }) {
  // Opened a second time, for the cloud, it starts empty. Each stage waits on
  // its own press of the footer button, whose label names the next one.
  const checking = useCue("install", -0.25) && !again;
  const checked = useCue("install", 0.05) && !again;
  const installing = useCue("install", 0.25) && !again;
  const installed = useCue("install", 0.55) && !again;
  const hostMode = useCue("install", 0.7) && !again;
  const hostModeOn = useCue("install", 0.95) && !again;
  const connected = useCue("install", 1.15) && !again;
  const step = (at: boolean, done: boolean) => (done ? "done" : at ? "running" : "todo");
  const action = hostModeOn
    ? "Connect"
    : installed
      ? "Turn on Host mode"
      : checked
        ? "Review install"
        : "Check host";
  return (
    <div
      className={cn(
        "absolute inset-2 flex flex-col gap-2 rounded-md border border-border-strong bg-surface-dialog p-2.5",
        reveal(open, "none")
      )}
    >
      <span className="text-2xs font-semibold text-text-primary">Add host</span>
      <span className="text-3xs text-text-secondary">
        A Mac or Linux machine you reach over SSH
      </span>
      <div
        data-tour-anchor="add-host-target"
        className="flex h-5 items-center gap-1.5 rounded-md border border-border-interactive bg-surface-input px-2 text-3xs text-text-primary"
      >
        <Server className="size-2.5 text-text-secondary" aria-hidden="true" />
        {again ? (
          <span className="text-text-secondary">user@host</span>
        ) : (
          <MockTyping
            cue="ssh"
            text={SSH_TARGET}
            delay={0.2}
            charsPerSecond={16}
            finishBy={{ cue: "install", offset: -0.7 }}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-0.5">
        <InstallStep label="Find" state={step(checking, checked)} />
        <InstallStep label="Check" state={step(checking, checked)} />
        <InstallStep label="Install" state={step(installing, installed)} />
        <InstallStep label="Host mode" state={step(hostMode, hostModeOn)} />
        <InstallStep label="Connect" state={step(connected, connected)} />
      </div>
      <span className="flex-1" />
      <div className="flex items-center gap-1.5">
        <FooterButton anchor="add-host-cloud">Create a cloud machine instead</FooterButton>
        <span className="flex-1" />
        <FooterButton anchor="add-host-check" primary>
          {action}
        </FooterButton>
      </div>
    </div>
  );
}

/**
 * The cloud machine dialog. With no account connected it asks for one first,
 * as the real one does; then the provider, account and name, and Create and connect.
 */
function CloudMachineDialog({ open, account }: { open: boolean; account: boolean }) {
  return (
    <div
      className={cn(
        "absolute inset-2 flex flex-col gap-2 rounded-md border border-border-strong bg-surface-dialog p-2.5",
        reveal(open, "none")
      )}
    >
      <span className="text-2xs font-semibold text-text-primary">New cloud machine</span>
      <div
        className={cn("absolute inset-x-2.5 top-8 flex flex-col gap-2", reveal(!account, "none"))}
      >
        <span className="text-3xs text-text-secondary">
          Connect a cloud provider account first. Daintree uses its API key to create, start and
          stop machines; the account pays for them.
        </span>
        <div className="flex flex-wrap gap-1.5">
          {["DigitalOcean", "AWS", "Google Cloud"].map((provider, i) => (
            <span
              key={provider}
              data-tour-anchor={i === 0 ? "cloud-connect-account" : undefined}
              className="rounded-md border border-border-subtle px-1.5 py-0.5 text-3xs text-text-primary"
            >
              Connect {provider} account
            </span>
          ))}
        </div>
      </div>
      <div className={cn("flex flex-col gap-2", reveal(account, "none"))}>
        <div className="flex gap-1.5">
          {["DigitalOcean", "AWS", "Google Cloud"].map((provider, i) => (
            <span
              key={provider}
              className={cn(
                "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-3xs",
                i === 0
                  ? "border-border-interactive bg-overlay-selected text-text-primary"
                  : "border-border-subtle text-text-secondary"
              )}
            >
              <Cloud className="size-2.5" aria-hidden="true" />
              {provider}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-3xs font-medium text-text-secondary">Account</span>
          <span className="flex h-5 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs text-text-primary">
            Personal
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-3xs font-medium text-text-secondary">Name</span>
          <span className="flex h-5 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs text-text-primary">
            gpu-runner
          </span>
        </div>
      </div>
      <span className="flex-1" />
      <div className={cn("flex justify-end", reveal(account, "none"))}>
        <FooterButton anchor="cloud-create" primary>
          Create and connect
        </FooterButton>
      </div>
    </div>
  );
}

function SettingsDialog({ open }: { open: boolean }) {
  const hostsPage = useCue("hosts", 0.3);
  const adding = useCue("add", 0.6);
  const sshAdded = useCue("install", 1.3);
  const addingAgain = useCue("cloud", -0.2);
  const cloudForm = useCue("cloud", 0.8);
  const accountConnected = useCue("cloud", 1.9);
  const provisioning = useCue("provision");
  const provisioned = useCue("provision", 1.6);
  const sshOpen = (adding && !sshAdded) || (addingAgain && !cloudForm);

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
          <div className="mt-1 flex flex-col gap-1">
            {(
              [
                ["build-box", "SSH · Linux", sshAdded],
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
        <AddHostDialog open={sshOpen} again={addingAgain} />
        <CloudMachineDialog open={cloudForm && !provisioning} account={accountConnected} />
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
      {host === "This Mac" ? (
        <Laptop className="size-2.5 text-text-secondary" aria-hidden="true" />
      ) : (
        <Server className="size-2.5 text-text-secondary" aria-hidden="true" />
      )}
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
            <Laptop className="size-2.5 text-text-secondary" aria-hidden="true" />
          )}
          <span className="flex-1">{fresh ? "New machine · Personal" : "This Mac"}</span>
          <ChevronDown className="size-2.5 text-text-secondary" aria-hidden="true" />
        </div>
      </div>
      <div className="flex justify-end">
        <span
          data-tour-anchor="placement-create"
          className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse"
        >
          {fresh ? "Create on new machine" : "Create worktree"}
        </span>
      </div>
    </div>
  );
}

export function HostsScene() {
  const settingsOpen = useCue("settings", 0.6);
  const hostsCue = useCue("hosts");
  const sshCue = useCue("ssh");
  const installCue = useCue("install");
  const pressing = useCue("install", -0.8);
  const sshAdded = useCue("install", 1.3);
  const addingAgain = useCue("cloud", -0.2);
  const cloudForm = useCue("cloud", 0.8);
  const accountConnected = useCue("cloud", 1.9);
  const provisionCue = useCue("provision");
  const chip = useCue("chip");
  const settingsClosed = useCue("chip", -0.4);
  const firstMenu = useCue("pick", 0.2);
  const picked = useCue("pick", 1.1);
  const switched = useCue("switch");
  const backMenu = useCue("placement", -2.0);
  const backHome = useCue("placement", -1.2);
  const formOpen = useCue("placement", -0.4);
  const choosing = useCue("placement", 0.6);
  const freshCue = useCue("fresh");
  const fresh = useCue("fresh", 0.3);
  const created = useCue("fresh", 1.2);
  const launching = useCue("running", -1.0);
  const launched = useCue("running", -0.4);
  const running = useCue("running");
  const away = useCue("running", 0.6);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  const settings = settingsOpen && !settingsClosed;
  const placing = formOpen && !created;
  // The window is on build-box from the pick until the person switches back,
  // then on the new machine once the worktree made for it is up.
  const onRemote = picked && !backHome;
  const host = created ? NEW_MACHINE : onRemote ? "build-box" : "This Mac";
  const hostMenuOpen = (firstMenu && !picked) || (backMenu && !backHome);
  const branch = created ? NEW_BRANCH : "main";

  const focus: readonly AppRegion[] | undefined =
    settings || placing ? [] : chip && !switched ? ["toolbar"] : undefined;

  const spotlight = running
    ? [`worktree-${NEW_BRANCH}`]
    : created && launching
      ? ["agent-codex"]
      : placing && freshCue
        ? ["placement-host", "placement-create"]
        : placing && choosing
          ? ["placement-host"]
          : switched && !backMenu
            ? ["host-chip", "worktree-list"]
            : chip && !firstMenu
              ? ["host-chip"]
              : settings && provisionCue
                ? ["host-row-cloud"]
                : settings && accountConnected
                  ? ["cloud-create"]
                  : settings && cloudForm
                    ? ["cloud-connect-account"]
                    : settings && addingAgain
                      ? ["add-host-cloud"]
                      : settings && sshAdded
                        ? ["host-row-ssh"]
                        : settings && pressing
                          ? ["add-host-check"]
                          : settings && (sshCue || installCue)
                            ? ["add-host-target"]
                            : settings && hostsCue
                              ? ["settings-nav-hosts"]
                              : [];

  return (
    <MockApp
      branch={branch}
      focus={focus}
      hostChip={chip ? <HostChip host={host} open={hostMenuOpen} /> : undefined}
      worktrees={
        created ? (
          <>
            <MockWorktreeCard name="shop-app" branch="main" />
            <MockWorktreeCard
              name={NEW_BRANCH}
              branch={NEW_BRANCH}
              selected
              states={launched ? ["working"] : []}
              className={reveal(created, "left")}
            />
          </>
        ) : onRemote ? (
          <>
            <MockWorktreeCard name="shop-app" branch="main" selected />
            <MockWorktreeCard name="load-test" branch="load-test" states={["working"]} />
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
        created && !launched ? (
          <MockEmptyGrid label={NEW_BRANCH} />
        ) : created ? (
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
        visible={hostMenuOpen}
        active={backMenu ? 0 : 1}
        x={HOST_MENU.x}
        y={HOST_MENU.y}
        width={HOST_MENU.width}
        items={[
          { icon: backMenu ? <Laptop /> : <Check />, label: "This Mac" },
          { icon: backMenu ? <Check /> : <Server />, label: "build-box" },
          { icon: <Server />, label: "gpu-runner", muted: true },
          { icon: <Plus />, label: "Add host…", muted: true, separator: true },
        ]}
      />
      <MockMenu
        anchor="placement-option"
        visible={placing && choosing && !fresh}
        active={freshCue ? 3 : 0}
        x={PLACEMENT_MENU.x}
        y={PLACEMENT_MENU.y}
        width={PLACEMENT_MENU.width}
        items={[
          { icon: <Laptop />, label: "This Mac" },
          { icon: <Server />, label: "build-box", muted: true },
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
