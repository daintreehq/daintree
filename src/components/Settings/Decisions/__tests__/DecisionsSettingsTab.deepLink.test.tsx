// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsDeepLinkScope } from "@/components/Settings/SettingsDialog";
import { DecisionsSettingsTab } from "../DecisionsSettingsTab";

const ORIGIN = "https://decisions.example.workers.dev";

const getStatus = vi.fn<() => Promise<DecisionsStatus>>();

const FINISHED: DecisionsStatus = {
  state: "connected",
  consentedAt: 1,
  relayOrigin: ORIGIN,
  keysStored: true,
  recoveryKitVerifiedAt: 7,
  setupCheck: { checkedAt: 8, failedStep: null },
};
// A verified kit with the setup check still to run: Connection leads.
const CHECK_TO_RUN: DecisionsStatus = { ...FINISHED, setupCheck: undefined };
const ORDERS: [string, DecisionsStatus][] = [
  ["everyday controls first", FINISHED],
  ["Connection first", CHECK_TO_RUN],
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderLinked(sectionId: string, query: string | null) {
  const onHandled = vi.fn();
  const request = { sectionId, query: query ?? undefined };
  render(
    <SettingsDeepLinkScope
      isActive
      scrollToSectionId={sectionId}
      query={query}
      request={request}
      onHandled={onHandled}
      tab="decisions"
    >
      <TooltipProvider>
        <DecisionsSettingsTab />
      </TooltipProvider>
    </SettingsDeepLinkScope>
  );
  return onHandled;
}

const kitSaveField = () =>
  document.querySelector<HTMLInputElement>("#decisions-recovery-kit-save input[type=password]");
const sentList = () => document.querySelector("#decisions-data-sent ul");

describe("Decisions settings links, in either order", () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView"
  );

  beforeEach(() => {
    getStatus.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
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
        events: { on: () => () => {} },
      },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    } else {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it.each(ORDERS)("lands on a section with %s", async (_, status) => {
    getStatus.mockResolvedValue(status);

    const onHandled = renderLinked("decisions-policy", "gates");
    await act(async () => {});

    expect(onHandled).toHaveBeenCalledExactlyOnceWith("decisions-policy", true);
    expect(document.querySelector("#decisions-policy.settings-highlight")).not.toBeNull();
  });

  it.each(ORDERS)(
    "lands on the note on dictating answers, now in Data, with %s",
    async (_, status) => {
      getStatus.mockResolvedValue(status);

      const onHandled = renderLinked("decisions-voice", "dictation");
      await act(async () => {});

      expect(onHandled).toHaveBeenCalledExactlyOnceWith("decisions-voice", true);
      expect(
        document.querySelector("#decisions-data #decisions-voice.settings-highlight")
      ).not.toBeNull();
    }
  );

  it.each(ORDERS)(
    "opens the folded recovery kit and focuses its field with %s",
    async (_, status) => {
      getStatus.mockResolvedValue(status);

      const onHandled = renderLinked("decisions-recovery-kit-save", "recovery kit");
      await act(async () => {});

      expect(onHandled).toHaveBeenCalledExactlyOnceWith("decisions-recovery-kit-save", true);
      expect(kitSaveField()).not.toBeNull();
      expect(document.activeElement).toBe(kitSaveField());
    }
  );

  it.each(ORDERS)("opens the list of what's sent, for a search, with %s", async (_, status) => {
    getStatus.mockResolvedValue(status);

    const onHandled = renderLinked("decisions-data", "privacy");
    await act(async () => {});

    expect(onHandled).toHaveBeenCalledExactlyOnceWith("decisions-data", true);
    expect(sentList()).not.toBeNull();
    expect(document.activeElement?.closest("#decisions-data-sent")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Details");
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the list closed for a link that isn't a search, and still lands on its row", async () => {
    getStatus.mockResolvedValue(FINISHED);

    const onHandled = renderLinked("decisions-data", null);
    await act(async () => {});

    expect(onHandled).toHaveBeenCalledExactlyOnceWith("decisions-data", true);
    expect(sentList()).toBeNull();
    expect(document.querySelector("#decisions-data-sent.settings-highlight")).not.toBeNull();
    expect(document.activeElement?.closest("#decisions-data-sent")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Details");
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
  });

  it("waits for the first read of the status, then lands on a row behind the switch", async () => {
    const read = deferred<DecisionsStatus>();
    getStatus.mockReturnValue(read.promise);

    const onHandled = renderLinked("decisions-voice", "dictation");
    await act(async () => {});
    expect(onHandled).not.toHaveBeenCalled();

    await act(async () => read.resolve(FINISHED));

    expect(onHandled).toHaveBeenCalledExactlyOnceWith("decisions-voice", true);
    expect(document.querySelector("#decisions-voice.settings-highlight")).not.toBeNull();
  });

  it("stops waiting when the first read fails, and reports the miss then", async () => {
    let fail!: (error: Error) => void;
    getStatus.mockReturnValue(
      new Promise<DecisionsStatus>((_, reject) => {
        fail = reject;
      })
    );

    const onHandled = renderLinked("decisions-voice", "dictation");
    await act(async () => {});
    expect(onHandled).not.toHaveBeenCalled();

    await act(async () => fail(new Error("no answer")));

    expect(onHandled).toHaveBeenCalledExactlyOnceWith("decisions-voice", false);
  });
});
