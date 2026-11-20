// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsSettingsTab } from "../DecisionsSettingsTab";

const ORIGIN = "https://decisions.example.workers.dev";

const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
const pushListeners = new Map<string, Set<(payload: unknown) => void>>();
let revision = 0;

/** Pushes a status to everything listening, as main's `decisions:status-changed` does. */
async function pushStatus(status: DecisionsStatus): Promise<void> {
  revision += 1;
  await act(async () => {
    for (const listener of pushListeners.get("decisions:status-changed") ?? []) {
      listener({ ...status, revision });
    }
  });
}

const FINISHED: DecisionsStatus = {
  state: "connected",
  consentedAt: 1,
  relayOrigin: ORIGIN,
  keysStored: true,
  recoveryKitVerifiedAt: 7,
  setupCheck: { checkedAt: 8, failedStep: null },
};
const FIRST_RUN_ORDER = [
  "decisions-connection",
  "decisions-devices",
  "decisions-hosts",
  "decisions-encryption",
  "decisions-agents",
  "decisions-questions",
  "decisions-policy",
  "decisions-model",
  "decisions-data",
];
const EVERYDAY_ORDER = [
  "decisions-agents",
  "decisions-questions",
  "decisions-policy",
  "decisions-model",
  "decisions-connection",
  "decisions-devices",
  "decisions-hosts",
  "decisions-encryption",
  "decisions-data",
];

/** The page's sections, top to bottom. */
function order(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".settings-section[id]"))
    .map((section) => section.id)
    .filter((id) => FIRST_RUN_ORDER.includes(id));
}

function tab(isActive: boolean) {
  return (
    <TooltipProvider>
      <DecisionsSettingsTab isActive={isActive} />
    </TooltipProvider>
  );
}

async function renderTab(status: DecisionsStatus, isActive = true) {
  getStatus.mockResolvedValue({ ...status, revision: 0 });
  const view = render(tab(isActive));
  await act(async () => {});
  return { setActive: (next: boolean) => view.rerender(tab(next)) };
}

describe("DecisionsSettingsTab section order", () => {
  beforeEach(() => {
    revision = 0;
    getStatus.mockReset();
    pushListeners.clear();
    Object.defineProperty(window, "electron", {
      value: {
        decisions: {
          getStatus,
          checkRelay: () => new Promise(() => {}),
          listDevices: () => new Promise(() => {}),
          listQuestions: () => new Promise(() => {}),
          listHosts: () => new Promise(() => {}),
          getPolicy: () => new Promise(() => {}),
          getModel: () => new Promise(() => {}),
          getSetupCheck: () => new Promise(() => {}),
          listAttention: () => new Promise(() => {}),
        },
        events: {
          on: (name: string, listener: (payload: unknown) => void) => {
            const listeners = pushListeners.get(name) ?? new Set();
            listeners.add(listener);
            pushListeners.set(name, listeners);
            return () => {
              listeners.delete(listener);
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

  it("leads with the everyday controls once setup is finished and the relay is connected", async () => {
    await renderTab(FINISHED);

    expect(order()).toEqual(EVERYDAY_ORDER);
  });

  it.each([
    ["no relay is set up", { state: "not-connected", consentedAt: 1 }],
    ["the recovery kit isn't verified", { ...FINISHED, recoveryKitVerifiedAt: undefined }],
    ["the setup check hasn't run", { ...FINISHED, setupCheck: undefined }],
    [
      "the setup check stopped at a step",
      { ...FINISHED, setupCheck: { checkedAt: 8, failedStep: "push" } },
    ],
    ["the relay is connecting", { ...FINISHED, state: "connecting" }],
    ["the relay is reconnecting", { ...FINISHED, state: "reconnecting" }],
    ["the relay is not connected", { ...FINISHED, state: "not-connected" }],
    ["another connection replaced this one", { ...FINISHED, state: "replaced" }],
    ["the relay revoked this computer", { ...FINISHED, state: "revoked" }],
    ["the connection has a problem", { ...FINISHED, problem: "keys" }],
  ] as [string, DecisionsStatus][])(
    "leads with Connection, as a first run does, while %s",
    async (_, status) => {
      await renderTab(status);

      expect(order()).toEqual(
        FIRST_RUN_ORDER.filter(
          (id) => status.relayOrigin !== undefined || id !== "decisions-encryption"
        )
      );
    }
  );

  it("keeps Connection first once it was shown first, through finishing setup", async () => {
    await renderTab({ ...FINISHED, setupCheck: undefined });
    expect(order()[0]).toBe("decisions-connection");

    await pushStatus(FINISHED);

    expect(order()).toEqual(FIRST_RUN_ORDER);
  });

  it("moves Connection up when the connection drops, and keeps it there on reconnecting", async () => {
    await renderTab(FINISHED);
    expect(order()).toEqual(EVERYDAY_ORDER);

    await pushStatus({ ...FINISHED, state: "reconnecting" });
    expect(order()).toEqual(FIRST_RUN_ORDER);

    await pushStatus(FINISHED);
    expect(order()).toEqual(FIRST_RUN_ORDER);
  });

  it("goes back to leading with the everyday controls after Decisions is turned off and on", async () => {
    await renderTab({ ...FINISHED, state: "reconnecting" });
    expect(order()[0]).toBe("decisions-connection");

    await pushStatus({ state: "off", consentedAt: 1 });
    expect(order()).toEqual([]);
    await pushStatus(FINISHED);

    expect(order()).toEqual(EVERYDAY_ORDER);
  });

  it("doesn't count a page that is still hidden as one that led with Connection", async () => {
    const { setActive } = await renderTab({ ...FINISHED, state: "connecting" }, false);
    expect(order()[0]).toBe("decisions-connection");

    await pushStatus(FINISHED);
    setActive(true);

    expect(order()).toEqual(EVERYDAY_ORDER);
  });

  it("keeps Connection first once the page was shown with it first", async () => {
    const { setActive } = await renderTab({ ...FINISHED, state: "connecting" }, false);

    setActive(true);
    await pushStatus(FINISHED);

    expect(order()).toEqual(FIRST_RUN_ORDER);
  });

  it("moves a section without remounting it", async () => {
    await renderTab({ ...FINISHED, state: "connecting" }, false);
    const policy = document.getElementById("decisions-policy");
    const connection = document.getElementById("decisions-connection");

    await pushStatus(FINISHED);

    expect(order()).toEqual(EVERYDAY_ORDER);
    expect(document.getElementById("decisions-policy")).toBe(policy);
    expect(document.getElementById("decisions-connection")).toBe(connection);
  });
});
