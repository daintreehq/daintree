import { describe, expect, it } from "vitest";
import {
  computeEffectiveNotificationState,
  heroLine,
  selectInterruptingKinds,
  selectKindOffKinds,
  KIND_SHORT_LABEL,
  type EffectiveStateInput,
  type KindEffectiveState,
} from "@/lib/notificationEffectiveState";
import type { NotificationEventKind } from "@/lib/notify";

const ALL_ON: EffectiveStateInput = {
  enabled: true,
  isQuiet: false,
  completedEnabled: true,
  waitingEnabled: true,
  workingPulseEnabled: true,
  uiFeedbackSoundEnabled: true,
};

function statusOf(states: KindEffectiveState[], kind: NotificationEventKind) {
  return states.find((s) => s.kind === kind)?.status;
}

describe("computeEffectiveNotificationState", () => {
  it("covers all ten kinds in EVENT_POLICY order", () => {
    const states = computeEffectiveNotificationState(ALL_ON);
    expect(states).toHaveLength(10);
    expect(states[0]?.kind).toBe("completed");
    expect(states[states.length - 1]?.kind).toBe("connectivity");
  });

  it("marks every kind disabled when global notifications are off", () => {
    const states = computeEffectiveNotificationState({ ...ALL_ON, enabled: false, isQuiet: true });
    expect(states.every((s) => s.status === "disabled")).toBe(true);
  });

  it("interrupts on active kinds and routes passive kinds to the inbox when nothing is muted", () => {
    const states = computeEffectiveNotificationState(ALL_ON);
    // Active kinds toast.
    expect(statusOf(states, "completed")).toBe("will-interrupt");
    expect(statusOf(states, "waiting")).toBe("will-interrupt");
    expect(statusOf(states, "agent")).toBe("will-interrupt");
    expect(statusOf(states, "git")).toBe("will-interrupt");
    expect(statusOf(states, "recovery")).toBe("will-interrupt");
    expect(statusOf(states, "connectivity")).toBe("will-interrupt");
    // time-sensitive host toasts too.
    expect(statusOf(states, "host")).toBe("will-interrupt");
    // Passive kinds only reach the inbox.
    expect(statusOf(states, "workingPulse")).toBe("inbox-only");
    expect(statusOf(states, "uiFeedback")).toBe("inbox-only");
    expect(statusOf(states, "settings")).toBe("inbox-only");
  });

  it("holds active kinds behind the quiet gate but lets host and waiting break through", () => {
    const states = computeEffectiveNotificationState({ ...ALL_ON, isQuiet: true });
    expect(statusOf(states, "completed")).toBe("quiet-gated");
    expect(statusOf(states, "agent")).toBe("quiet-gated");
    expect(statusOf(states, "recovery")).toBe("quiet-gated");
    // host carries `urgent` (time-sensitive) and bypasses the quiet gate.
    expect(statusOf(states, "host")).toBe("will-interrupt");
    // waiting pages through quiet at the OS-native layer (main-process burst).
    expect(statusOf(states, "waiting")).toBe("will-interrupt");
  });

  it("gates a switched-off waiting kind even though waiting would otherwise bypass quiet", () => {
    const states = computeEffectiveNotificationState({
      ...ALL_ON,
      isQuiet: true,
      waitingEnabled: false,
    });
    // Toggle-off wins over the quiet bypass — a silenced kind never fires.
    expect(statusOf(states, "waiting")).toBe("kind-off");
  });

  it("classifies a switched-off notification kind as kind-off, regardless of the quiet gate", () => {
    const states = computeEffectiveNotificationState({
      ...ALL_ON,
      isQuiet: true,
      completedEnabled: false,
    });
    expect(statusOf(states, "completed")).toBe("kind-off");
    // agent has no toggle and is held by the quiet gate.
    expect(statusOf(states, "agent")).toBe("quiet-gated");
  });

  it("classifies a switched-off sound kind as sound-off, never kind-off", () => {
    const states = computeEffectiveNotificationState({
      ...ALL_ON,
      workingPulseEnabled: false,
      uiFeedbackSoundEnabled: false,
    });
    expect(statusOf(states, "workingPulse")).toBe("sound-off");
    expect(statusOf(states, "uiFeedback")).toBe("sound-off");
  });

  it("never reports kinds without a per-kind toggle as kind-off or sound-off", () => {
    const states = computeEffectiveNotificationState(ALL_ON);
    for (const kind of ["agent", "git", "host", "recovery", "settings", "connectivity"] as const) {
      expect(statusOf(states, kind)).not.toBe("kind-off");
      expect(statusOf(states, kind)).not.toBe("sound-off");
    }
  });
});

describe("selectors", () => {
  it("selectInterruptingKinds returns only the kinds that toast right now (EVENT_POLICY order)", () => {
    const states = computeEffectiveNotificationState({ ...ALL_ON, isQuiet: true });
    // waiting precedes host in EVENT_POLICY declaration order.
    expect(selectInterruptingKinds(states)).toEqual(["waiting", "host"]);
  });

  it("selectKindOffKinds returns switched-off notification kinds but not sound kinds", () => {
    const states = computeEffectiveNotificationState({
      ...ALL_ON,
      completedEnabled: false,
      workingPulseEnabled: false,
    });
    expect(selectKindOffKinds(states)).toEqual(["completed"]);
  });
});

describe("heroLine", () => {
  it("leads with the interrupting kinds", () => {
    const states = computeEffectiveNotificationState(ALL_ON);
    const line = heroLine(states);
    expect(line.startsWith("Will interrupt you: ")).toBe(true);
    expect(line).toContain(KIND_SHORT_LABEL.waiting);
    expect(line).toContain(KIND_SHORT_LABEL.host);
  });

  it("names only what breaks through during a mute", () => {
    const states = computeEffectiveNotificationState({ ...ALL_ON, isQuiet: true });
    expect(heroLine(states)).toBe("Will interrupt you: Waiting, System");
  });

  it("states plainly when nothing will interrupt", () => {
    const states = computeEffectiveNotificationState({ ...ALL_ON, enabled: false });
    expect(heroLine(states)).toBe("Nothing will interrupt you right now");
  });
});
