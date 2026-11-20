// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const remote = vi.hoisted(() => ({ hostName: null as string | null }));
vi.mock("@/hooks/useSettingsOwner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useSettingsOwner")>()),
  useRemoteHostName: () => remote.hostName,
}));

import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { CliAvailability } from "@shared/types";
import type { DecisionsDevice, DecisionsPolicy } from "@shared/types/decisions";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
} from "@shared/types/decisionsQuestion";
import { DecisionsStatusFacts } from "../DecisionsStatusFacts";
import type { UseDecisionsDevicesResult } from "../useDecisionsDevices";
import type { UseDecisionsPolicyResult } from "../useDecisionsPolicy";

const INSTALLED: CliAvailability = {
  claude: "ready",
  codex: "unauthenticated",
  cursor: "installed",
  gemini: "missing",
};

const PHONE: DecisionsDevice = {
  deviceId: "dev_phone",
  label: "Pixel 9",
  role: "phone",
  pairedAt: "2026-10-30T00:00:00.000Z",
  lastSeenAt: null,
  pushEnabled: true,
};

const listQuestions = vi.fn<() => Promise<DecisionQuestionList>>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();

function push(list: DecisionQuestionList): void {
  for (const listener of listeners.get("decisions:questions-changed") ?? []) listener(list);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function devicesRead(
  devices: DecisionsDevice[] | null,
  failure: string | null = null
): UseDecisionsDevicesResult {
  return { devices, failure, loading: devices === null && failure === null, reload: () => {} };
}

function policyRead(
  askHumanAgents: string[] | null,
  loadError: string | null = null
): UseDecisionsPolicyResult {
  const policy: DecisionsPolicy | null =
    askHumanAgents === null
      ? null
      : {
          gates: [],
          defaultQuestionExpiryMs: 1,
          maxQuestionExpiryMs: 2,
          askHumanAgents,
          revision: 0,
        };
  return {
    policy,
    loadError,
    pendingExpiry: null,
    expirySaveFailure: null,
    pendingAgents: new Map(),
    agentSaveFailures: new Map(),
    reload: async () => {},
    setDefaultQuestionExpiry: async () => {},
    setAgentAskHuman: async () => {},
  };
}

function asked(askedAt: string): DecisionQuestionListItem {
  return { askedAt } as unknown as DecisionQuestionListItem;
}

function facts(): string {
  return screen.getByTestId("decisions-status-facts").textContent ?? "";
}

async function renderFacts(
  devices: UseDecisionsDevicesResult = devicesRead([PHONE]),
  policy: UseDecisionsPolicyResult = policyRead(["claude"])
) {
  const view = render(<DecisionsStatusFacts devices={devices} policy={policy} />);
  await act(async () => {});
  return view;
}

describe("DecisionsStatusFacts (#18059)", () => {
  beforeEach(() => {
    remote.hostName = null;
    listeners.clear();
    listQuestions.mockReset();
    listQuestions.mockResolvedValue({ revision: 1, questions: [] });
    useCliAvailabilityStore.setState({ availability: INSTALLED, hasRealData: true, error: null });
    Object.defineProperty(window, "electron", {
      value: {
        decisions: { listQuestions },
        events: {
          on: (name: string, listener: (payload: unknown) => void) => {
            const set = listeners.get(name) ?? new Set();
            set.add(listener);
            listeners.set(name, set);
            return () => {
              set.delete(listener);
            };
          },
        },
      },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("holds every fact's place before anything is read, then fills each in", async () => {
    const list = deferred<DecisionQuestionList>();
    listQuestions.mockReturnValue(list.promise);
    const view = await renderFacts(devicesRead(null), policyRead(null));
    expect(facts()).toBe("Reading phones… · Reading agents… · Reading questions…");

    const lastAsked = new Date(Date.now() - 5 * 60_000).toISOString();
    view.rerender(
      <DecisionsStatusFacts devices={devicesRead([PHONE])} policy={policyRead(["claude"])} />
    );
    expect(facts()).toBe("1 phone with notifications · 1 agent switched on · Reading questions…");
    await act(async () => {
      list.resolve({ revision: 1, questions: [asked(lastAsked)] });
    });

    expect(facts()).toMatch(/^1 phone with notifications · 1 agent switched on · Last question /);
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(lastAsked);
    // One line that clips in a narrow window, so its title carries all of it.
    expect(screen.getByTestId("decisions-status-facts").title).toBe(facts());
  });

  it("counts the phones and tablets the relay can notify, nothing else", async () => {
    await renderFacts(
      devicesRead([
        PHONE,
        { ...PHONE, deviceId: "dev_quiet", pushEnabled: false },
        { ...PHONE, deviceId: "dev_ipad", role: "tablet" },
        { ...PHONE, deviceId: "dev_host", role: "desktop-host" },
        { ...PHONE, deviceId: "dev_owner", role: "owner-desktop" },
      ])
    );
    expect(facts()).toMatch(/^2 devices with notifications · /);
    cleanup();

    await renderFacts(devicesRead([PHONE, { ...PHONE, deviceId: "dev_other" }]));
    expect(facts()).toMatch(/^2 phones with notifications · /);
    cleanup();

    await renderFacts(devicesRead([{ ...PHONE, deviceId: "dev_ipad", role: "tablet" }]));
    expect(facts()).toMatch(/^1 device with notifications · /);
    cleanup();

    // A tablet the relay can't notify doesn't change what the notified ones are called.
    await renderFacts(
      devicesRead([PHONE, { ...PHONE, deviceId: "dev_ipad", role: "tablet", pushEnabled: false }])
    );
    expect(facts()).toMatch(/^1 phone with notifications · /);
    cleanup();

    await renderFacts(devicesRead([{ ...PHONE, pushEnabled: false }]));
    expect(facts()).toMatch(/^No phones with notifications · /);
    cleanup();

    await renderFacts(devicesRead(null, "The relay didn't answer in time."));
    expect(facts()).toMatch(/^Phones couldn't be read · /);
  });

  it("counts the agents switched on that the Agents section shows a switch for", async () => {
    // codex is supported but left off; cursor has no launch-time MCP, gemini
    // isn't installed, and the last is gone.
    await renderFacts(undefined, policyRead(["claude", "cursor", "gemini", "removed"]));
    expect(facts()).toContain(" · 1 agent switched on · ");
    cleanup();

    await renderFacts(undefined, policyRead(["claude", "codex"]));
    expect(facts()).toContain(" · 2 agents switched on · ");
    cleanup();

    await renderFacts(undefined, policyRead([]));
    expect(facts()).toContain(" · No agents switched on · ");
    cleanup();

    await renderFacts(undefined, policyRead(null, "Main didn't answer."));
    expect(facts()).toContain(" · Agents couldn't be read · ");
  });

  it("waits for the installed agents before counting them", async () => {
    useCliAvailabilityStore.setState({ hasRealData: false, error: null });
    await renderFacts();
    expect(facts()).toContain(" · Reading agents… · ");

    act(() => useCliAvailabilityStore.setState({ hasRealData: true }));
    expect(facts()).toContain(" · 1 agent switched on · ");
    cleanup();

    useCliAvailabilityStore.setState({ hasRealData: false, error: "The probe failed." });
    await renderFacts();
    expect(facts()).toContain(" · Agents couldn't be read · ");
    cleanup();

    // A policy that lists no agent needs no probe to say none is switched on (#18057).
    await renderFacts(undefined, policyRead([]));
    expect(facts()).toContain(" · No agents switched on · ");
  });

  it("names no agents in a remote window, whose agents are the Host's", async () => {
    remote.hostName = "studio";
    await renderFacts();
    expect(facts()).toBe("1 phone with notifications · No questions yet");
  });

  it("follows the question list to the newest question, whatever its order", async () => {
    const newest = "2026-11-20T10:00:00.000Z";
    listQuestions.mockResolvedValue({
      revision: 1,
      questions: [
        asked("2026-11-19T10:00:00.000Z"),
        asked(newest),
        asked("2026-11-19T11:00:00.000Z"),
        asked("not a time"),
      ],
    });
    await renderFacts();
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(newest);

    const later = "2026-11-20T11:00:00.000Z";
    act(() => push({ revision: 2, questions: [asked(newest), asked(later)] }));
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(later);

    act(() => push({ revision: 3, questions: [] }));
    expect(facts()).toMatch(/ · No questions yet$/);
  });

  it("says a list it couldn't read, until a push brings one", async () => {
    listQuestions.mockRejectedValue(new Error("store closed"));
    await renderFacts();
    expect(facts()).toMatch(/ · Questions couldn't be read$/);

    act(() => push({ revision: 3, questions: [] }));
    expect(facts()).toMatch(/ · No questions yet$/);

    const askedAt = "2026-11-20T09:00:00.000Z";
    act(() => push({ revision: 4, questions: [asked(askedAt)] }));
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(askedAt);
  });

  it("tells a list of questions with no readable time apart from an empty one", async () => {
    listQuestions.mockResolvedValue({
      revision: 1,
      questions: [asked("not a time"), asked("nor this")],
    });
    await renderFacts();
    expect(facts()).toMatch(/ · Last question time unknown$/);
  });

  it("stops following the list once it's gone", async () => {
    const view = await renderFacts();
    expect(listeners.get("decisions:questions-changed")?.size).toBe(1);
    expect(listQuestions).toHaveBeenCalledOnce();

    view.unmount();
    expect(listeners.get("decisions:questions-changed")?.size).toBe(0);
  });
});
