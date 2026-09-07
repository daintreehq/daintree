import { performance } from "node:perf_hooks";

import type { PerfScenario, ScenarioSample } from "../types";
import type { NotificationSettings } from "../../../shared/types/ipc/api";
import type { WaitingReason } from "../../../shared/types/agent";
import {
  appStateForFleet,
  buildFleet,
  buildIdleCorpus,
  buildRoutingScript,
  createWindowFleet,
  defaultNotificationSettings,
  disposeWindowFleet,
  emitStateChange,
  gradeIdleSweep,
  gradeRoutingCase,
  loadNotificationModules,
  notificationBus,
  NotificationClock,
  onScreenProvider,
  resetBusObservations,
  type ExpectedNotification,
  type FleetTerminal,
  type IdleTerminalRow,
  type NotificationModules,
  type PerfWindowFleet,
  type RoutingCase,
  type StateChangeInput,
} from "../lib/notificationFixture";

/**
 * The notification subsystem — the part of Daintree that decides, for every
 * agent-state transition a fleet produces, whether the user is told.
 *
 * PERF-320..325 drive the real `AgentNotificationService`,
 * `NotificationService` and `IdleTerminalNotificationService` in a plain Node
 * process; `lib/notificationFixture.ts` states what that costs and what it does
 * not cover. No OS notification is ever sent.
 *
 * Every scenario here grades BOTH directions against an expectation table held
 * in this file's fixture, because the two failure modes are symmetric and both
 * are fast: a service that notifies nothing is instant and silent, and a
 * service that notifies about everything is nearly as quick and considerably
 * worse. A dedup window or an idle gate that fails open looks healthy in every
 * latency number this harness can take.
 *
 * These scenarios report what the service DECIDED. Agent state is a passive
 * heuristic and frequently wrong; nothing here claims a decision was correct
 * about the agent, only that it matched the routing contract for the event it
 * was given.
 */

/** The renderer that owns every watched panel in these fixtures. */
const OWNER_WEB_CONTENTS_ID = 100;

/** Long enough for the 8s boot grace to lapse before any measured event. */
const BOOT_GRACE_SETTLE_MS = 9_000;

/**
 * Flush window between routing cases: past the 2s completion debounce, its 0ms
 * burst flush and the 200ms waiting burst, so each case is attributable.
 */
const CASE_FLUSH_MS = 2_500;

const ROUTING_FLEET_SIZE = 48;

/** Equal decision counts across both PERF-321 arms: 8 shapes × 48 terminals. */
const SCALING_DECISIONS = 384;
const SMALL_FLEET_SIZE = 8;
const LARGE_FLEET_SIZE = 96;

interface Harness {
  modules: NotificationModules;
  clock: NotificationClock;
  fleet: FleetTerminal[];
  windows: PerfWindowFleet;
}

/**
 * Bring the real services up over a seeded fleet, run `body`, and tear them
 * down. The virtual clock is installed for the whole body and uninstalled in a
 * finally — a leaked patch would corrupt every later scenario in the process.
 */
async function withNotificationHarness<T>(
  fleetSize: number,
  configure: (bus: ReturnType<typeof notificationBus>) => void,
  body: (harness: Harness) => Promise<T>
): Promise<T> {
  const modules = await loadNotificationModules();
  const bus = notificationBus();
  resetBusObservations();
  bus.settings = defaultNotificationSettings();
  bus.projects = [];
  bus.currentProjectId = null;
  bus.osDnd = undefined;
  configure(bus);

  const fleet = buildFleet(fleetSize);
  modules.store.set("appState", appStateForFleet(fleet, "idle"));

  const clock = new NotificationClock();
  clock.install();

  const windows = createWindowFleet(1);
  modules.notificationService.initialize(windows.registry, windows.lookup);
  modules.agentNotificationService.dispose();
  modules.agentNotificationService.initialize();
  await clock.tick(BOOT_GRACE_SETTLE_MS);
  modules.agentNotificationService.syncWatchedPanels(
    OWNER_WEB_CONTENTS_ID,
    fleet.filter((terminal) => terminal.watched).map((terminal) => terminal.id)
  );

  try {
    return await body({ modules, clock, fleet, windows });
  } finally {
    modules.agentNotificationService.dispose();
    modules.notificationService.dispose();
    disposeWindowFleet(windows);
    clock.uninstall();
  }
}

interface DriveResult {
  /** Real time spent inside `events.emit` — the synchronous decision. */
  syncMs: number;
  /** Real time for the whole drive, including the timer callbacks that fire. */
  wholeMs: number;
  /** Notification-log index before each case, for exact attribution. */
  marks: number[];
  schemaFailures: number;
}

/**
 * Emit each case and flush its timers before the next one.
 *
 * The only bookkeeping inside the timed region is one array length read per
 * case; every comparison against the expectation table happens after the
 * measurement is taken.
 */
async function driveRoutingScript(
  harness: Harness,
  cases: readonly RoutingCase[],
  flushBetweenCases: boolean
): Promise<DriveResult> {
  const bus = notificationBus();
  const marks: number[] = [];
  let schemaFailures = 0;
  let syncMs = 0;

  const wholeStart = performance.now();
  for (const routingCase of cases) {
    marks.push(bus.nativeNotifications.length);
    const emitStart = performance.now();
    const accepted = emitStateChange(harness.modules, harness.clock, routingCase.input);
    syncMs += performance.now() - emitStart;
    if (!accepted) schemaFailures += 1;
    if (flushBetweenCases) await harness.clock.tick(CASE_FLUSH_MS);
  }
  const wholeMs = performance.now() - wholeStart;

  return { syncMs, wholeMs, marks, schemaFailures };
}

interface RoutingGradeTotals {
  missed: number;
  spurious: number;
  bodyMismatch: number;
  clickMisses: number;
  produced: number;
}

/**
 * Grade every case against the table, then click each notification the subject
 * produced and check the navigate landed on the renderer that owns the panel.
 *
 * Runs entirely outside the timed region.
 */
function gradeRouting(
  cases: readonly RoutingCase[],
  marks: readonly number[],
  expectedOwnerId: number
): RoutingGradeTotals {
  const bus = notificationBus();
  const totals: RoutingGradeTotals = {
    missed: 0,
    spurious: 0,
    bodyMismatch: 0,
    clickMisses: 0,
    produced: bus.nativeNotifications.length,
  };

  cases.forEach((routingCase, index) => {
    const from = marks[index] ?? bus.nativeNotifications.length;
    const to = marks[index + 1] ?? bus.nativeNotifications.length;
    const observed = bus.nativeNotifications.slice(from, to);
    const grade = gradeRoutingCase(routingCase.expected, observed);
    totals.missed += grade.missed;
    totals.spurious += grade.spurious;
    totals.bodyMismatch += grade.bodyMismatch;
  });

  // An "allow" that hands back nothing is indistinguishable from a suppression:
  // a notification whose click reaches no renderer is a dead banner.
  for (const notification of bus.nativeNotifications) {
    const before = bus.rendererSends.length;
    notification.click();
    const sent = bus.rendererSends.slice(before);
    if (sent.length !== 1 || sent[0]!.targetId !== expectedOwnerId) totals.clickMisses += 1;
  }

  return totals;
}

/**
 * Bring the agent service back to a known state between battery cases: drop
 * every timer and buffer, install this case's settings, re-seed `appState`, and
 * re-declare the watch set (dispose clears it).
 *
 * `settleMs` is how far past `initialize()` the case starts, which is the boot
 * grace period's own input — a case that must observe the grace passes 0.
 */
async function resetAgentService(
  harness: Harness,
  settings: Partial<NotificationSettings>,
  settleMs: number
): Promise<void> {
  const bus = notificationBus();
  harness.modules.agentNotificationService.dispose();
  // The gate battery (PERF-322) represents a user who has sound turned on,
  // so each row can grade its own named gate — master toggle, per-type,
  // watch, spawn/boot grace, mute, quiet hours, escalation, all-clear —
  // without every "must not fire" row being confounded by soundEnabled's
  // product default (off, #12185). No case below overrides soundEnabled, so
  // this is the effective baseline for the whole battery.
  bus.settings = { ...defaultNotificationSettings(), soundEnabled: true, ...settings };
  bus.osDnd = undefined;
  harness.modules.store.set("appState", appStateForFleet(harness.fleet, "idle"));
  harness.modules.agentNotificationService.initialize();
  if (settleMs > 0) await harness.clock.tick(settleMs);
  harness.modules.agentNotificationService.syncWatchedPanels(
    OWNER_WEB_CONTENTS_ID,
    harness.fleet.filter((terminal) => terminal.watched).map((terminal) => terminal.id)
  );
  resetBusObservations();
}

function emit(harness: Harness, input: StateChangeInput): void {
  emitStateChange(harness.modules, harness.clock, input);
}

function waiting(terminalId: string, agentId: string, reason: WaitingReason): StateChangeInput {
  return {
    terminalId,
    agentId,
    worktreeId: "wt-0",
    state: "waiting",
    previousState: "working",
    waitingReason: reason,
  };
}

interface GateCase {
  label: string;
  reason: string;
  settings: Partial<NotificationSettings>;
  settleMs: number;
  /** Pin `Math.random` for cases whose subject jitters its own schedule. */
  pinRandom?: number;
  expected: { notifications: number; sounds: number };
  body: (harness: Harness) => Promise<void>;
}

const GATE_CASE_COUNT = 24;

/**
 * A quiet-hours window that certainly contains this moment.
 *
 * `isScheduledQuietNow` reads `new Date()`, which the virtual clock does not
 * patch (it patches `Date.now`), so the window is computed from the real wall
 * clock rather than assumed — a fixed 22:00–08:00 window would make this case
 * pass or fail depending on what time the benchmark was run.
 */
function quietWindowCoveringNow(): Partial<NotificationSettings> {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return {
    quietHoursEnabled: true,
    quietHoursStartMin: (nowMin + 1440 - 30) % 1440,
    quietHoursEndMin: (nowMin + 31) % 1440,
    quietHoursWeekdays: [],
  };
}

/**
 * The suppression table. Every row names what must happen and why, and the
 * rows are deliberately paired — each gate appears once in its suppressing
 * configuration and once in the configuration where the same signal must get
 * through, so neither "never notify" nor "always notify" can score zero.
 *
 * Panel ids come from `buildFleet`: panel-0 is docked and watched, panel-1
 * docked and unwatched, panel-2 grid and watched, panel-3 grid and unwatched,
 * panel-4 docked and watched.
 */
function buildGateBattery(): GateCase[] {
  return [
    {
      label: "master-toggle-off",
      reason: "the master toggle is the one switch that must silence everything",
      settings: { enabled: false, completedEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "master-toggle-on",
      reason: "the same event with the toggle on is the control for the row above",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "both-types-off",
      reason: "with neither OS type enabled the routing path returns before the burst",
      settings: { completedEnabled: false, waitingEnabled: false },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "completed-type-off",
      reason: "completed notifications are off by default and must stay off",
      settings: { completedEnabled: false, waitingEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "completed",
          previousState: "working",
        });
        await h.clock.tick(2_500);
      },
    },
    {
      label: "completed-type-on",
      reason: "the control for the row above: the same settle must notify once",
      settings: { completedEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "completed",
          previousState: "working",
        });
        await h.clock.tick(2_500);
      },
    },
    {
      label: "unwatched-panel",
      reason: "an OS notification is for a panel no renderer is watching",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        emit(h, waiting("panel-3", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "spawn-grace-suppresses",
      reason: "an agent that boots straight into waiting has not asked for anything yet",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        h.modules.events.emit("agent:spawned", {
          agentId: "claude",
          terminalId: "panel-0",
          timestamp: h.clock.now(),
        });
        await h.clock.tick(1_000);
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "spawn-grace-expired",
      reason: "past the 5s grace the same wait is a real one",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        h.modules.events.emit("agent:spawned", {
          agentId: "claude",
          terminalId: "panel-0",
          timestamp: h.clock.now(),
        });
        await h.clock.tick(6_000);
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "spawn-grace-cleared-by-work",
      reason: "waiting to working means the user answered, so the next wait is legitimate",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        h.modules.events.emit("agent:spawned", {
          agentId: "claude",
          terminalId: "panel-0",
          timestamp: h.clock.now(),
        });
        await h.clock.tick(1_000);
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "working",
          previousState: "waiting",
        });
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "boot-grace-suppresses-spawn-sound",
      reason: "restored terminals re-emit spawn on startup and must not chime",
      settings: { uiFeedbackSoundEnabled: true },
      settleMs: 0,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        h.modules.events.emit("agent:spawned", {
          agentId: "claude",
          terminalId: "panel-0",
          timestamp: h.clock.now(),
        });
        await h.clock.tick(300);
      },
    },
    {
      label: "boot-grace-expired-spawn-sound",
      reason: "past the 8s boot grace a spawn is a user action and does chime",
      settings: { uiFeedbackSoundEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 1 },
      body: async (h) => {
        h.modules.events.emit("agent:spawned", {
          agentId: "claude",
          terminalId: "panel-0",
          timestamp: h.clock.now(),
        });
        await h.clock.tick(300);
      },
    },
    {
      label: "session-mute-suppresses-completed",
      reason: "the renderer's quick-mute drops queued completion alerts",
      settings: { completedEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        h.modules.agentNotificationService.setSessionMuteUntil(h.clock.now() + 60_000);
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "completed",
          previousState: "working",
        });
        await h.clock.tick(2_500);
      },
    },
    {
      label: "session-mute-passes-waiting",
      reason: "a waiting agent blocks the user's own work, so it pages through the mute",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        h.modules.agentNotificationService.setSessionMuteUntil(h.clock.now() + 60_000);
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "quiet-hours-suppresses-completed",
      reason: "the scheduled quiet window drops the same queued completion",
      settings: { completedEnabled: true, ...quietWindowCoveringNow() },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "completed",
          previousState: "working",
        });
        await h.clock.tick(2_500);
      },
    },
    {
      label: "quiet-hours-passes-waiting",
      reason: "waiting pages through quiet hours for the same reason it beats the mute",
      settings: quietWindowCoveringNow(),
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(300);
      },
    },
    {
      label: "os-dnd-skips-pulse-ticks",
      reason: "OS Focus silences each pulse tick but must leave the loop alive",
      settings: { workingPulseEnabled: true, soundEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      pinRandom: 0,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        notificationBus().osDnd = true;
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "working",
          previousState: "idle",
        });
        await h.clock.tick(34_000);
      },
    },
    {
      label: "os-dnd-clear-pulses",
      reason: "with Focus off the same window pulses on its 10s delay and 8s floor",
      settings: { workingPulseEnabled: true, soundEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      pinRandom: 0,
      expected: { notifications: 0, sounds: 4 },
      body: async (h) => {
        notificationBus().osDnd = false;
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "working",
          previousState: "idle",
        });
        await h.clock.tick(34_000);
      },
    },
    {
      label: "escalation-fires-for-docked",
      reason: "a docked agent still waiting after the delay earns the loud notification",
      settings: { waitingEscalationEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 2, sounds: 2 },
      body: async (h) => {
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(181_000);
      },
    },
    {
      label: "escalation-skips-grid",
      reason: "a grid panel is on screen, so only the burst notification is owed",
      settings: { waitingEscalationEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        emit(h, waiting("panel-2", "gemini", "approval"));
        await h.clock.tick(181_000);
      },
    },
    {
      label: "escalation-independent-of-watch",
      reason: "an unwatched docked panel gets no burst but still escalates",
      settings: { waitingEscalationEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        emit(h, waiting("panel-1", "codex", "approval"));
        await h.clock.tick(181_000);
      },
    },
    {
      label: "escalation-groups-siblings",
      reason: "three docked waits escalate once, not three times",
      settings: { waitingEscalationEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 2, sounds: 2 },
      body: async (h) => {
        emit(h, waiting("panel-0", "claude", "approval"));
        emit(h, waiting("panel-4", "codex", "approval"));
        emit(h, waiting("panel-1", "codex", "approval"));
        await h.clock.tick(181_000);
      },
    },
    {
      label: "escalation-cancelled-on-leave",
      reason: "an agent that gets its answer must not be escalated minutes later",
      settings: { waitingEscalationEnabled: true },
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 1, sounds: 1 },
      body: async (h) => {
        emit(h, waiting("panel-0", "claude", "approval"));
        await h.clock.tick(5_000);
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "working",
          previousState: "waiting",
        });
        await h.clock.tick(181_000);
      },
    },
    {
      label: "all-clear-below-peak",
      reason: "one agent finishing is not a fleet going quiet",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 0 },
      body: async (h) => {
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "working",
          previousState: "idle",
        });
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "completed",
          previousState: "working",
        });
        await h.clock.tick(600);
      },
    },
    {
      label: "all-clear-fires-at-peak",
      reason: "two concurrent agents going quiet is the state the all-clear exists for",
      settings: {},
      settleMs: BOOT_GRACE_SETTLE_MS,
      expected: { notifications: 0, sounds: 1 },
      body: async (h) => {
        // The peak is read from appState, so the snapshot has to show the two
        // agents as working at the moment the second one starts.
        h.modules.store.set("appState", appStateForFleet(h.fleet, "working"));
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "working",
          previousState: "idle",
        });
        h.modules.store.set("appState", appStateForFleet(h.fleet, "idle"));
        emit(h, {
          terminalId: "panel-0",
          agentId: "claude",
          worktreeId: "wt-0",
          state: "completed",
          previousState: "working",
        });
        await h.clock.tick(600);
      },
    },
  ];
}

interface BurstArm {
  label: string;
  reason: string;
  settings: Partial<NotificationSettings>;
  expected: ExpectedNotification[];
  /** Returns the number of state-change events the arm emitted. */
  body: (harness: Harness) => Promise<number>;
}

/** The six collapse shapes, with the copy each one must end up producing. */
function buildBurstArms(fleet: readonly FleetTerminal[]): BurstArm[] {
  const watched = fleet.filter((terminal) => terminal.watched);
  const burst = watched.slice(0, 24);
  const few = watched.slice(0, 4);
  const reasons: WaitingReason[] = ["approval", "question", "error", "prompt"];

  return [
    {
      label: "uniform-reason-burst",
      reason: "24 simultaneous waits collapse to one notification naming all 24",
      settings: {},
      expected: [{ title: "Agents waiting", body: "24 agents waiting for approval" }],
      body: async (h) => {
        for (const terminal of burst) emit(h, waiting(terminal.id, terminal.agentId, "approval"));
        await h.clock.tick(300);
        return burst.length;
      },
    },
    {
      label: "mixed-reason-burst",
      reason: "a mixed burst must keep the generic copy rather than overclaim for any member",
      settings: {},
      expected: [{ title: "Agents waiting", body: "24 agents waiting for input" }],
      body: async (h) => {
        burst.forEach((terminal, index) => {
          emit(h, waiting(terminal.id, terminal.agentId, reasons[index % reasons.length]!));
        });
        await h.clock.tick(300);
        return burst.length;
      },
    },
    {
      label: "cycling-terminal-dedup",
      reason: "a terminal that flaps inside the window is one waiting agent, not two",
      settings: {},
      expected: [{ title: "Agents waiting", body: "4 agents waiting for approval" }],
      body: async (h) => {
        for (const terminal of few) emit(h, waiting(terminal.id, terminal.agentId, "approval"));
        const first = few[0]!;
        emit(h, {
          terminalId: first.id,
          agentId: first.agentId,
          worktreeId: "wt-0",
          state: "working",
          previousState: "waiting",
        });
        emit(h, waiting(first.id, first.agentId, "approval"));
        await h.clock.tick(300);
        return few.length + 2;
      },
    },
    {
      label: "exited-terminal-spliced",
      reason: "a terminal that dies inside the window must not be announced as waiting",
      settings: {},
      expected: [{ title: "Agents waiting", body: "3 agents waiting for approval" }],
      body: async (h) => {
        for (const terminal of few) emit(h, waiting(terminal.id, terminal.agentId, "approval"));
        const last = few[few.length - 1]!;
        emit(h, {
          terminalId: last.id,
          agentId: last.agentId,
          worktreeId: "wt-0",
          state: "exited",
          previousState: "waiting",
        });
        await h.clock.tick(300);
        return few.length + 1;
      },
    },
    {
      label: "completion-burst",
      reason: "24 agents finishing together collapse to one notification naming all 24",
      settings: { completedEnabled: true },
      expected: [{ title: "Agents completed", body: "24 agents finished their tasks" }],
      body: async (h) => {
        for (const terminal of burst) {
          emit(h, {
            terminalId: terminal.id,
            agentId: terminal.agentId,
            worktreeId: "wt-0",
            state: "completed",
            previousState: "working",
          });
        }
        await h.clock.tick(2_500);
        return burst.length;
      },
    },
    {
      label: "completion-cancelled-by-resume",
      reason: "agents that go back to work inside the debounce never finished",
      settings: { completedEnabled: true },
      expected: [],
      body: async (h) => {
        for (const terminal of few) {
          emit(h, {
            terminalId: terminal.id,
            agentId: terminal.agentId,
            worktreeId: "wt-0",
            state: "completed",
            previousState: "working",
          });
        }
        for (const terminal of few) {
          emit(h, {
            terminalId: terminal.id,
            agentId: terminal.agentId,
            worktreeId: "wt-0",
            state: "working",
            previousState: "completed",
          });
        }
        await h.clock.tick(2_500);
        return few.length * 2;
      },
    },
  ];
}

// --- PERF-324 helpers --------------------------------------------------------

const IDLE_PROJECT_COUNT = 40;
const IDLE_TERMINALS_PER_PROJECT = 6;
const IDLE_THRESHOLD_MINUTES = 60;
/** The service's own cadence — one sweep per tick of this size. */
const IDLE_CHECK_INTERVAL_MS = 5 * 60_000;
const IDLE_SWEEP_COUNT = 4;

/** Project ids the sweep actually broadcast, and how many broadcasts it took. */
function drainIdleBroadcasts(): { projectIds: Set<string>; broadcastCount: number } {
  const bus = notificationBus();
  const projectIds = new Set<string>();
  for (const entry of bus.broadcasts) {
    const payload = entry.payload as { projects?: Array<{ projectId?: string }> };
    for (const project of payload?.projects ?? []) {
      if (project.projectId) projectIds.add(project.projectId);
    }
  }
  const broadcastCount = bus.broadcasts.length;
  bus.broadcasts = [];
  return { projectIds, broadcastCount };
}

/**
 * Symmetric difference between the throttle the service persisted and the set
 * it should hold, read back out of electron-store rather than out of the
 * broadcast — the broadcast is the service's report of what it did, and the
 * store is the state a later sweep will actually consult.
 */
function throttleKeyMisses(modules: NotificationModules, expectedIds: readonly string[]): number {
  const raw = modules.store.get("idleTerminalNotifiedAt");
  const keys = new Set(
    raw && typeof raw === "object" ? Object.keys(raw as Record<string, unknown>) : []
  );
  const expected = new Set(expectedIds);
  let misses = 0;
  for (const id of expected) if (!keys.has(id)) misses += 1;
  for (const id of keys) if (!expected.has(id)) misses += 1;
  return misses;
}

// --- PERF-325 helpers --------------------------------------------------------

const BADGE_WINDOW_COUNT = 3;
const BADGE_VIEWS_PER_WINDOW = 8;
const BADGE_PHASE_COUNT = 4;

/** Titles written since the previous phase, per window, clearing as it reads. */
function readTitlePhase(fleet: PerfWindowFleet): { total: number; byWindow: string[][] } {
  const byWindow = fleet.windows.map((perfWindow) => {
    const written = [...perfWindow.titles];
    perfWindow.titles.length = 0;
    return written;
  });
  return { total: byWindow.reduce((sum, titles) => sum + titles.length, 0), byWindow };
}

/**
 * Independent restatement of `composeWindowTitle`. Calling the product's own
 * composer here would agree with the subject by construction.
 */
function expectedWindowTitle(projectName: string, waitingCount: number): string {
  return waitingCount > 0 ? `(${waitingCount}) ${projectName}` : projectName;
}

function countTitleMisses(
  fleet: PerfWindowFleet,
  counts: ReadonlyMap<number, number>,
  excluded: ReadonlySet<number>,
  byWindow: readonly string[][]
): number {
  let misses = 0;
  fleet.windows.forEach((perfWindow, index) => {
    const sum = perfWindow.viewWebContentsIds.reduce(
      (total, viewId) => (excluded.has(viewId) ? total : total + (counts.get(viewId) ?? 0)),
      0
    );
    const expected = expectedWindowTitle(perfWindow.projectName, sum);
    for (const title of byWindow[index] ?? []) {
      if (title !== expected) misses += 1;
    }
  });
  return misses;
}

function expectedTotal(counts: ReadonlyMap<number, number>, excluded: ReadonlySet<number>): number {
  let total = 0;
  for (const [viewId, count] of counts) if (!excluded.has(viewId)) total += count;
  return total;
}

/**
 * The Dock badge is written on macOS only, so this can fail only there. The
 * title readings are what carry the scenario on Windows and Linux, and
 * `badgeWriteCount` reports the platform difference rather than hiding it.
 */
function gradeBadgeValue(observed: number | undefined, expected: number): number {
  if (process.platform !== "darwin") return 0;
  return observed === expected ? 0 : 1;
}

/** A measurement that did not happen, reported as misses rather than thrown. */
function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

export const notificationScenarios: PerfScenario[] = [
  {
    id: "PERF-320",
    name: "Agent State Transition Routing (fleet)",
    description:
      "Route 384 real agent-state transitions across a 48-panel fleet through the real AgentNotificationService and NotificationService, grading every decision in both directions against a table held in the fixture: each watched panel entering waiting or settling into completed/exited must produce exactly one notification with the declared copy, and every other transition — and every transition of an unwatched panel — must produce none. Each notification is then clicked and the navigate must reach the owning renderer. No OS notification is ever sent.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: [
      "missedNotificationMisses",
      "spuriousNotificationMisses",
      "notificationBodyMisses",
      "clickRoutingMisses",
      "payloadSchemaMisses",
      "decisionShortfallCount",
    ],
    async run() {
      return withNotificationHarness(
        ROUTING_FLEET_SIZE,
        (bus) => {
          // Both notification types on; escalation and the pulse off because
          // they are timer-driven and would land inside a later case.
          bus.settings.completedEnabled = true;
          bus.settings.waitingEnabled = true;
          bus.settings.waitingEscalationEnabled = false;
          bus.settings.workingPulseEnabled = false;
        },
        async (harness) => {
          const cases = buildRoutingScript(harness.fleet);
          const drive = await driveRoutingScript(harness, cases, true);
          const totals = gradeRouting(cases, drive.marks, OWNER_WEB_CONTENTS_ID);
          const bus = notificationBus();
          const expectedNotifications = cases.filter((c) => c.expected !== null).length;

          return {
            durationMs: drive.wholeMs,
            metrics: {
              routingDecisionCount: cases.length,
              notificationCount: totals.produced,
              suppressedDecisionCount: cases.length - totals.produced,
              soundPlayCount: bus.soundFiles.length,
              // Deterministic by construction; reported so a table that
              // silently shrank is visible beside a duration that improved.
              decisionShortfallCount: Math.max(0, ROUTING_FLEET_SIZE * 8 - cases.length),
              expectedNotificationCount: expectedNotifications,
              missedNotificationMisses: totals.missed,
              spuriousNotificationMisses: totals.spurious,
              notificationBodyMisses: totals.bodyMismatch,
              clickRoutingMisses: totals.clickMisses,
              payloadSchemaMisses: drive.schemaFailures,
              pendingTimerCount: harness.clock.pendingTimers(),
            },
            notes:
              totals.spurious > 0
                ? `${totals.spurious} notification(s) fired for a transition that must be suppressed`
                : undefined,
          };
        }
      );
    },
  },
  {
    id: "PERF-321",
    name: "Routing Cost Against Fleet Size",
    description:
      "The same 384 transitions routed against an 8-panel and a 96-panel fleet, timing ONLY the synchronous decision (events.emit through handleStateChanged) with the virtual-clock flush outside the bracket. Every transition re-reads appState through the product's cached-read proxy, which structuredClones the whole snapshot and then scans it twice, so the per-decision cost carries the fleet with it — this is the number that says how much a busy fleet pays per state change. Both arms are graded by the same two-directional routing table.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: [
      "missedNotificationMisses",
      "spuriousNotificationMisses",
      "notificationBodyMisses",
      "payloadSchemaMisses",
      "decisionShortfallCount",
    ],
    async run() {
      const arms: Array<{ size: number; syncMs: number; decisions: number }> = [];
      let missed = 0;
      let spurious = 0;
      let bodyMisses = 0;
      let schemaFailures = 0;
      let shortfall = 0;
      let wholeMs = 0;

      for (const size of [SMALL_FLEET_SIZE, LARGE_FLEET_SIZE]) {
        await withNotificationHarness(
          size,
          (bus) => {
            bus.settings.completedEnabled = true;
            bus.settings.waitingEnabled = true;
            bus.settings.waitingEscalationEnabled = false;
            bus.settings.workingPulseEnabled = false;
          },
          async (harness) => {
            const script = buildRoutingScript(harness.fleet);
            const cases: RoutingCase[] = [];
            while (cases.length < SCALING_DECISIONS) {
              cases.push(...script.slice(0, SCALING_DECISIONS - cases.length));
            }
            const drive = await driveRoutingScript(harness, cases, true);
            const totals = gradeRouting(cases, drive.marks, OWNER_WEB_CONTENTS_ID);
            missed += totals.missed;
            spurious += totals.spurious;
            bodyMisses += totals.bodyMismatch;
            schemaFailures += drive.schemaFailures;
            shortfall += Math.max(0, SCALING_DECISIONS - cases.length);
            wholeMs += drive.wholeMs;
            arms.push({ size, syncMs: drive.syncMs, decisions: cases.length });
          }
        );
      }

      const small = arms[0];
      const large = arms[1];
      if (!small || !large) {
        return failClosed("one of the two fleet arms never ran", {
          missedNotificationMisses: SCALING_DECISIONS,
          spuriousNotificationMisses: 0,
          notificationBodyMisses: 0,
          payloadSchemaMisses: 0,
          decisionShortfallCount: SCALING_DECISIONS,
        });
      }

      const smallPerDecisionUs = (small.syncMs * 1000) / small.decisions;
      const largePerDecisionUs = (large.syncMs * 1000) / large.decisions;

      return {
        durationMs: wholeMs,
        metrics: {
          smallFleetTerminalCount: SMALL_FLEET_SIZE,
          largeFleetTerminalCount: LARGE_FLEET_SIZE,
          routingDecisionCount: small.decisions + large.decisions,
          smallFleetPerDecisionUs: smallPerDecisionUs,
          largeFleetPerDecisionUs: largePerDecisionUs,
          fleetScalingOverheadRatio:
            smallPerDecisionUs > 0 ? largePerDecisionUs / smallPerDecisionUs : 0,
          missedNotificationMisses: missed,
          spuriousNotificationMisses: spurious,
          notificationBodyMisses: bodyMisses,
          payloadSchemaMisses: schemaFailures,
          decisionShortfallCount: shortfall,
        },
        notes: `${LARGE_FLEET_SIZE}-panel fleet costs ${(largePerDecisionUs / Math.max(smallPerDecisionUs, 1e-9)).toFixed(2)}x per decision`,
      };
    },
  },
  {
    id: "PERF-322",
    name: "Notification Suppression Gate Battery",
    description:
      "24 suppression decisions against the real AgentNotificationService, each declared with the reason it must fire or must not: the master toggle, the per-type toggles, the watched-panel gate, the 5s spawn grace and its clear-on-work path, the 8s boot grace, session mute and scheduled quiet hours (which suppress completions but deliberately let waiting page through), OS Do-Not-Disturb over the working pulse, dock-only escalation with its grouped sibling cancellation, and the all-clear peak floor. Graded both ways: a gate that fails open is fast and wrong, and one that suppresses everything is faster and just as wrong.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["gateFailOpenMisses", "gateFailClosedMisses", "gateShortfallCount"],
    async run() {
      return withNotificationHarness(
        ROUTING_FLEET_SIZE,
        () => undefined,
        async (harness) => {
          const bus = notificationBus();
          const cases = buildGateBattery();
          let failOpen = 0;
          let failClosed = 0;
          let evaluated = 0;
          let notificationTotal = 0;
          let soundTotal = 0;

          // Only the case body is timed: the per-case reset rewrites `appState`
          // through electron-store, and an atomic whole-file write is fixture
          // cost that would swamp the decision this scenario is about.
          let decisionMs = 0;
          for (const gateCase of cases) {
            await resetAgentService(harness, gateCase.settings, gateCase.settleMs);
            const randomOriginal = Math.random;
            if (gateCase.pinRandom !== undefined) Math.random = () => gateCase.pinRandom!;
            const caseStart = performance.now();
            try {
              await gateCase.body(harness);
            } finally {
              decisionMs += performance.now() - caseStart;
              Math.random = randomOriginal;
            }
            const notifications = bus.nativeNotifications.length;
            const sounds = bus.soundPlays.length + bus.soundFiles.length + bus.soundPulses;
            notificationTotal += notifications;
            soundTotal += sounds;
            evaluated += 1;
            failOpen += Math.max(0, notifications - gateCase.expected.notifications);
            failOpen += Math.max(0, sounds - gateCase.expected.sounds);
            failClosed += Math.max(0, gateCase.expected.notifications - notifications);
            failClosed += Math.max(0, gateCase.expected.sounds - sounds);
          }

          return {
            durationMs: decisionMs,
            metrics: {
              gateDecisionCount: evaluated,
              gateNotificationCount: notificationTotal,
              gateSoundCount: soundTotal,
              gateFailOpenMisses: failOpen,
              gateFailClosedMisses: failClosed,
              gateShortfallCount: Math.max(0, GATE_CASE_COUNT - evaluated),
              pendingTimerCount: harness.clock.pendingTimers(),
            },
            notes: failOpen > 0 ? `${failOpen} suppression decision(s) failed OPEN` : undefined,
          };
        }
      );
    },
  },
  {
    id: "PERF-323",
    name: "Notification Burst Collapse and Dedup",
    description:
      "Six bursts through the real 200ms waiting window and 2s completion debounce: a uniform-reason burst, a mixed-reason burst whose copy must stay generic, a terminal that cycles waiting-working-waiting inside the window and must be counted once, a terminal that exits inside the window and must be spliced out, a 24-agent completion burst, and a completion burst cancelled by the agents going back to work. Reports events in against notifications out, and grades the grouped copy — collapsing everything into nothing is the cheapest possible collapse, and the count in the body is what proves it did not.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["burstFailOpenMisses", "burstFailClosedMisses", "groupedSubjectMisses"],
    async run() {
      return withNotificationHarness(
        ROUTING_FLEET_SIZE,
        () => undefined,
        async (harness) => {
          const bus = notificationBus();
          const arms = buildBurstArms(harness.fleet);
          let failOpen = 0;
          let failClosed = 0;
          let subjectMisses = 0;
          let events = 0;
          let notifications = 0;

          // The per-arm reset is fixture cost (an electron-store whole-file
          // write), so only the burst itself is inside the bracket.
          let burstMs = 0;
          for (const arm of arms) {
            await resetAgentService(harness, arm.settings, BOOT_GRACE_SETTLE_MS);
            const armStart = performance.now();
            events += await arm.body(harness);
            burstMs += performance.now() - armStart;
            const observed = bus.nativeNotifications;
            notifications += observed.length;
            failOpen += Math.max(0, observed.length - arm.expected.length);
            failClosed += Math.max(0, arm.expected.length - observed.length);
            arm.expected.forEach((expected, index) => {
              const actual = observed[index];
              if (!actual) return;
              if (actual.title !== expected.title || actual.body !== expected.body) {
                subjectMisses += 1;
              }
            });
          }

          return {
            durationMs: burstMs,
            metrics: {
              burstEventCount: events,
              burstNotificationCount: notifications,
              // Both terms are tallies, so the collapse travels between machines.
              eventsPerNotificationRatio: notifications > 0 ? events / notifications : 0,
              burstArmCount: arms.length,
              burstFailOpenMisses: failOpen,
              burstFailClosedMisses: failClosed,
              groupedSubjectMisses: subjectMisses,
              pendingTimerCount: harness.clock.pendingTimers(),
            },
            notes:
              failOpen > 0
                ? `${failOpen} burst notification(s) escaped the collapse window`
                : undefined,
          };
        }
      );
    },
  },
  {
    id: "PERF-324",
    name: "Idle Terminal Sweep Decision",
    description:
      "Four real check cycles of IdleTerminalNotificationService over 40 projects and 240 terminals, driven through start() so the 2-minute startup quiet window, the 5s initial check and the 5-minute cadence are the product's own. Every project carries a declared verdict and a reason — idle, on screen in some window, holding a working agent, recently active, terminal-less, PTY-less, activity-less, or muted — and the sweep is graded in both directions: the eligible projects must be broadcast and no other project may be. The throttle is then read back out of electron-store, cleared by real activity, and must notify again.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: [
      "idleNotifyMisses",
      "idleSpuriousMisses",
      "quietWindowMisses",
      "throttleStateMisses",
      "sweepShortfallCount",
    ],
    async run() {
      const modules = await loadNotificationModules();
      const bus = notificationBus();
      resetBusObservations();
      const clock = new NotificationClock();
      clock.install();

      const service = modules.getIdleTerminalNotificationService();
      try {
        const corpus = buildIdleCorpus(
          IDLE_PROJECT_COUNT,
          IDLE_TERMINALS_PER_PROJECT,
          clock.now(),
          IDLE_THRESHOLD_MINUTES
        );
        const rows = { current: corpus.terminals as IdleTerminalRow[] };
        bus.projects = corpus.cases.map((c) => ({ id: c.projectId, name: c.projectName }));
        bus.currentProjectId = null;

        modules.store.set("idleTerminalNotify", {
          enabled: true,
          thresholdMinutes: IDLE_THRESHOLD_MINUTES,
        });
        modules.store.set(
          "idleTerminalDismissals",
          Object.fromEntries(corpus.dismissedProjectIds.map((id) => [id, clock.now()]))
        );
        modules.store.set("idleTerminalNotifiedAt", {});

        service.stop();
        service.setPtyClient({
          getAllTerminalsAsync: async () => rows.current,
        } as unknown as Parameters<typeof service.setPtyClient>[0]);
        service.setProjectViewManagersProvider(onScreenProvider(corpus.onScreenProjectIds));
        service.start();

        let notifyMisses = 0;
        let spuriousMisses = 0;
        let throttleMisses = 0;
        let sweeps = 0;
        let broadcasts = 0;
        let notifiedProjects = 0;

        // Only the sweeps themselves are timed. Draining the broadcast log,
        // grading it and re-seeding the terminal rows between cycles is
        // fixture work and stays outside the bracket.
        let sweepMs = 0;
        const timedTick = async (ms: number): Promise<void> => {
          const start = performance.now();
          await clock.tick(ms);
          sweepMs += performance.now() - start;
        };

        // The 5s initial check lands inside the 2-minute startup quiet window
        // and must broadcast nothing at all.
        await timedTick(10_000);
        const quietWindowMisses = bus.broadcasts.length;

        // Sweep 1 — the first real cadence tick.
        await timedTick(IDLE_CHECK_INTERVAL_MS);
        sweeps += 1;
        const first = drainIdleBroadcasts();
        broadcasts += first.broadcastCount;
        notifiedProjects += first.projectIds.size;
        const firstGrade = gradeIdleSweep(corpus.expectedNotifiedIds, first.projectIds);
        notifyMisses += firstGrade.missed;
        spuriousMisses += firstGrade.spurious;
        throttleMisses += throttleKeyMisses(modules, corpus.expectedNotifiedIds);

        // Sweep 2 — nothing changed, so the notified-at cooldown must hold.
        await timedTick(IDLE_CHECK_INTERVAL_MS);
        sweeps += 1;
        const second = drainIdleBroadcasts();
        broadcasts += second.broadcastCount;
        spuriousMisses += gradeIdleSweep([], second.projectIds).spurious;

        // Sweep 3 — the idle projects see real output, so they leave the
        // eligible state and their throttle must be cleared rather than kept.
        rows.current = rows.current.map((row) =>
          corpus.expectedNotifiedIds.includes(row.projectId)
            ? { ...row, lastOutputTime: clock.now() }
            : row
        );
        await timedTick(IDLE_CHECK_INTERVAL_MS);
        sweeps += 1;
        const third = drainIdleBroadcasts();
        broadcasts += third.broadcastCount;
        spuriousMisses += gradeIdleSweep([], third.projectIds).spurious;
        throttleMisses += throttleKeyMisses(modules, []);

        // Sweep 4 — idle again. With the throttle cleared, a fresh idle period
        // notifies again; a throttle that was never cleared reports as a miss.
        const staleAt = clock.now() - (IDLE_THRESHOLD_MINUTES + 5) * 60_000;
        rows.current = rows.current.map((row) =>
          corpus.expectedNotifiedIds.includes(row.projectId)
            ? { ...row, lastInputTime: staleAt, lastOutputTime: staleAt }
            : row
        );
        await timedTick(IDLE_CHECK_INTERVAL_MS);
        sweeps += 1;
        const fourth = drainIdleBroadcasts();
        broadcasts += fourth.broadcastCount;
        notifiedProjects += fourth.projectIds.size;
        const fourthGrade = gradeIdleSweep(corpus.expectedNotifiedIds, fourth.projectIds);
        notifyMisses += fourthGrade.missed;
        spuriousMisses += fourthGrade.spurious;

        return {
          durationMs: sweepMs,
          metrics: {
            idleSweepCount: sweeps,
            idleProjectCount: corpus.cases.length,
            idleTerminalScanCount: corpus.terminalCount,
            idleBroadcastCount: broadcasts,
            idleNotifiedProjectCount: notifiedProjects,
            eligibleProjectCount: corpus.expectedNotifiedIds.length,
            idleNotifyMisses: notifyMisses,
            idleSpuriousMisses: spuriousMisses,
            quietWindowMisses,
            throttleStateMisses: throttleMisses,
            sweepShortfallCount: Math.max(0, IDLE_SWEEP_COUNT - sweeps),
          },
          notes:
            spuriousMisses > 0
              ? `${spuriousMisses} project(s) were nudged that must have been suppressed`
              : undefined,
        };
      } finally {
        service.stop();
        clock.uninstall();
      }
    },
  },
  {
    id: "PERF-325",
    name: "Waiting Badge and Window Title Fan-out",
    description:
      "24 project-view renderers reporting waiting counts into three windows through the real NotificationService: the 300ms debounce must collapse 24 updates into one apply pass, each window's title must carry its own summed count through the product's title composition, a destroyed window's owners must be pruned out of the badge, a window focus must zero only the view that window is showing, and removeOwner must apply immediately. The badge is macOS-only by design, so badgeWriteCount reads 0 elsewhere and the title readings carry the scenario there.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 15 },
    warmups: 2,
    correctness: [
      "applyPassMisses",
      "titleContentMisses",
      "badgeTotalMisses",
      "phaseShortfallCount",
    ],
    async run() {
      const modules = await loadNotificationModules();
      const bus = notificationBus();
      resetBusObservations();
      const clock = new NotificationClock();
      clock.install();
      const fleet = createWindowFleet(BADGE_WINDOW_COUNT, BADGE_VIEWS_PER_WINDOW);

      try {
        modules.notificationService.initialize(fleet.registry, fleet.lookup);

        const counts = new Map<number, number>();
        fleet.windows.forEach((perfWindow, windowIndex) => {
          perfWindow.viewWebContentsIds.forEach((viewId, viewIndex) => {
            counts.set(viewId, windowIndex + viewIndex + 1);
          });
        });

        let applyPassMisses = 0;
        let titleContentMisses = 0;
        let badgeTotalMisses = 0;
        let titleWrites = 0;
        let phases = 0;

        // Each phase records the titles it produced, the badge value that stood
        // at its end and the owners excluded by then; the whole comparison
        // against the expectations runs after the last phase is measured.
        const observed: Array<{
          expectedTitleWrites: number;
          excluded: Set<number>;
          byWindow: string[][];
          total: number;
          badge: number | undefined;
        }> = [];
        const excluded = new Set<number>();
        let applyMs = 0;

        const capture = (expectedTitleWrites: number): void => {
          const phase = readTitlePhase(fleet);
          titleWrites += phase.total;
          phases += 1;
          observed.push({
            expectedTitleWrites,
            excluded: new Set(excluded),
            byWindow: phase.byWindow,
            total: phase.total,
            badge: bus.badgeCounts[bus.badgeCounts.length - 1],
          });
        };

        // Phase 1: every renderer reports inside one debounce window.
        let start = performance.now();
        for (const [viewId, count] of counts) {
          modules.notificationService.updateNotifications(viewId, { waitingCount: count });
        }
        await clock.tick(400);
        applyMs += performance.now() - start;
        capture(BADGE_WINDOW_COUNT);
        const debouncedApplyPassCount = bus.badgeCounts.length;

        // Phase 2: a window is destroyed — its owners must be pruned out.
        const dead = fleet.windows[BADGE_WINDOW_COUNT - 1]!;
        const survivor = fleet.windows[0]!.viewWebContentsIds[0]!;
        start = performance.now();
        dead.destroy();
        modules.notificationService.updateNotifications(survivor, {
          waitingCount: counts.get(survivor) ?? 0,
        });
        await clock.tick(400);
        applyMs += performance.now() - start;
        for (const viewId of dead.viewWebContentsIds) excluded.add(viewId);
        capture(BADGE_WINDOW_COUNT - 1);

        // Phase 3: focusing a window zeroes only the view it is showing.
        const focused = fleet.windows[0]!;
        start = performance.now();
        focused.emitFocus();
        applyMs += performance.now() - start;
        excluded.add(focused.webContentsId);
        capture(BADGE_WINDOW_COUNT - 1);

        // Phase 4: a renderer goes away and its count applies immediately.
        const removed = fleet.windows[0]!.viewWebContentsIds[1]!;
        start = performance.now();
        modules.notificationService.removeOwner(removed);
        applyMs += performance.now() - start;
        excluded.add(removed);
        capture(BADGE_WINDOW_COUNT - 1);

        for (const phase of observed) {
          applyPassMisses += Math.abs(phase.total - phase.expectedTitleWrites);
          titleContentMisses += countTitleMisses(fleet, counts, phase.excluded, phase.byWindow);
          badgeTotalMisses += gradeBadgeValue(phase.badge, expectedTotal(counts, phase.excluded));
        }

        return {
          durationMs: applyMs,
          metrics: {
            ownerCount: counts.size,
            windowCount: BADGE_WINDOW_COUNT,
            notificationUpdateCount: counts.size + 1,
            titleWriteCount: titleWrites,
            badgeWriteCount: bus.badgeCounts.length,
            debouncedApplyPassCount,
            applyPassMisses,
            titleContentMisses,
            badgeTotalMisses,
            phaseShortfallCount: Math.max(0, BADGE_PHASE_COUNT - phases),
          },
          notes:
            applyPassMisses > 0
              ? `${applyPassMisses} apply pass(es) more or fewer than the debounce contract allows`
              : undefined,
        };
      } finally {
        modules.notificationService.dispose();
        disposeWindowFleet(fleet);
        clock.uninstall();
      }
    },
  },
];
