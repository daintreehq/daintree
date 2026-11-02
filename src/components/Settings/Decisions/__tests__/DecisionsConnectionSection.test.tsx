// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsRelayCheck,
  DecisionsRelayCompatibility,
  DecisionsSetupCheckStartResult,
  DecisionsStatus,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsConnectionSection } from "../DecisionsConnectionSection";

const ORIGIN = "https://decisions.example.workers.dev";
const checkRelay = vi.fn<(url: string) => Promise<DecisionsRelayCheck>>();
const startSetupCheck = vi.fn<() => Promise<DecisionsSetupCheckStartResult>>();

/** The bridge the section reaches: the relay check, and the setup check's read, start and cancel. */
function electronStub() {
  return {
    decisions: {
      checkRelay,
      getSetupCheck: () => Promise.resolve(null),
      startSetupCheck,
      cancelSetupCheck: () => Promise.resolve(null),
    },
    events: { on: () => () => {} },
  };
}

const SAME: DecisionsRelayCompatibility = {
  relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
  daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
  diverges: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSection(status: DecisionsStatus, locked = false) {
  return render(
    <TooltipProvider>
      <DecisionsConnectionSection status={status} locked={locked} />
    </TooltipProvider>
  );
}

function urlField(): HTMLInputElement {
  return screen.getByPlaceholderText(ORIGIN) as HTMLInputElement;
}

function checkButton(name = "Check"): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

async function typeAndCheck(value: string) {
  fireEvent.change(urlField(), { target: { value } });
  await act(async () => {
    fireEvent.submit(urlField().form!);
  });
}

describe("DecisionsConnectionSection relay check", () => {
  beforeEach(() => {
    checkRelay.mockReset();
    Object.defineProperty(window, "electron", {
      value: electronStub(),
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("asks main to check exactly what was typed, and shows what it observed", async () => {
    checkRelay.mockResolvedValue({ result: "unclaimed", origin: ORIGIN, compatibility: SAME });
    renderSection({ state: "not-connected" });

    expect(checkButton().disabled).toBe(true);
    await typeAndCheck("decisions.example.workers.dev/pair?ticket=x");

    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(
      "decisions.example.workers.dev/pair?ticket=x"
    );
    expect(screen.getByText("decisions.example.workers.dev is ready to claim")).toBeTruthy();
    expect(screen.getByText("Relay and Daintree versions match")).toBeTruthy();
  });

  it.each<[string, DecisionsRelayCheck, string, RegExp]>([
    [
      "unreachable",
      { result: "unreachable", origin: ORIGIN, endpoint: "health", reason: "dns" },
      "Couldn't reach decisions.example.workers.dev",
      /^Its name doesn't resolve/,
    ],
    [
      "not a relay",
      { result: "not-a-relay", origin: ORIGIN, endpoint: "info", answered: "status", status: 404 },
      "decisions.example.workers.dev isn't a Decisions relay",
      /^\/api\/v1\/info answered HTTP 404$/,
    ],
    [
      "claimed",
      { result: "claimed", origin: ORIGIN, compatibility: SAME },
      "decisions.example.workers.dev is claimed",
      /already has an owner/,
    ],
    [
      "claim secret not configured",
      { result: "claim-not-configured", origin: ORIGIN, compatibility: SAME },
      "decisions.example.workers.dev has no claim secret set",
      /until CLAIM_SECRET is set on the Worker/,
    ],
  ])("says a relay is %s, and what was seen", async (_label, result, text, detail) => {
    checkRelay.mockResolvedValue(result);
    renderSection({ state: "not-connected" });

    await typeAndCheck(ORIGIN);

    const row = document.getElementById("decisions-relay-check")!;
    expect(within(row).getByText(text)).toBeTruthy();
    expect(within(row).getByText(detail)).toBeTruthy();
  });

  it("names both protocol ranges for an incompatible relay, with the update prompt", async () => {
    checkRelay.mockResolvedValue({
      result: "incompatible",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: 2, protocolMax: 3, workerVersion: "0.4.0" },
        daintree: SAME.daintree,
        diverges: true,
      },
    });
    renderSection({ state: "not-connected" });

    await typeAndCheck(ORIGIN);

    expect(
      screen.getByText("The relay speaks protocols 2–3; Daintree speaks protocol 1")
    ).toBeTruthy();
    expect(screen.getByText("The relay is newer than Daintree")).toBeTruthy();
    expect(screen.getByText(/Update Daintree to match it/)).toBeTruthy();
  });

  it("puts an address main refused to send on the field itself", async () => {
    checkRelay.mockResolvedValue({ result: "invalid-url", reason: "not-https" });
    renderSection({ state: "not-connected" });

    await typeAndCheck("http://decisions.example.workers.dev");

    expect(urlField().getAttribute("aria-invalid")).toBe("true");
    // Under the field, and announced: it arrives after the submit, not as the person types.
    const copies = screen.getAllByText("Use the relay's https:// address");
    const announced = copies.filter((copy) => copy.closest('[role="status"]'));
    const shown = copies.filter((copy) => !copy.closest('[role="status"]'));
    expect([announced.length, shown.length]).toEqual([1, 1]);
    const errorId = shown[0]!.closest("[id]")!.id;
    expect(urlField().getAttribute("aria-describedby")?.split(" ")).toContain(errorId);
  });

  it("drops a check still out once the address is edited", async () => {
    const pending = deferred<DecisionsRelayCheck>();
    checkRelay.mockReturnValue(pending.promise);
    renderSection({ state: "not-connected" });

    await typeAndCheck(ORIGIN);
    fireEvent.change(urlField(), { target: { value: "https://other.example.workers.dev" } });
    await act(async () => {
      pending.resolve({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    });

    expect(screen.queryByText("decisions.example.workers.dev is claimed")).toBeNull();
    expect(checkButton().disabled).toBe(false);
  });

  it("forgets the observation when the address changes after it", async () => {
    checkRelay.mockResolvedValue({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    renderSection({ state: "not-connected" });

    await typeAndCheck(ORIGIN);
    expect(screen.getByText("decisions.example.workers.dev is claimed")).toBeTruthy();
    fireEvent.change(urlField(), { target: { value: `${ORIGIN}/` } });

    expect(screen.queryByText("decisions.example.workers.dev is claimed")).toBeNull();
  });

  it("says a check main couldn't make on the row, and checks again on request", async () => {
    checkRelay.mockRejectedValueOnce(new Error("Turn on Decisions to check a relay"));
    checkRelay.mockResolvedValueOnce({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    renderSection({ state: "not-connected" });

    await typeAndCheck(ORIGIN);
    expect(screen.getAllByText(/Couldn't check the relay\. Turn on Decisions/)).toHaveLength(2);

    await act(async () => {
      fireEvent.submit(urlField().form!);
    });
    expect(checkRelay).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn't check the relay/)).toBeNull();
  });

  it("waits for the switch to settle before checking a connected relay by itself", async () => {
    checkRelay.mockResolvedValue({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    const connected: DecisionsStatus = { state: "connected", relayOrigin: ORIGIN };

    const view = renderSection(connected, true);
    expect(checkRelay).not.toHaveBeenCalled();
    expect(checkButton().disabled).toBe(true);

    await act(async () => {
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={connected} locked={false} />
        </TooltipProvider>
      );
    });
    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);
  });

  it("checks once on mount when already connected, not again for an equal status", async () => {
    checkRelay.mockResolvedValue({ result: "claimed", origin: ORIGIN, compatibility: SAME });

    const view = renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});
    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);

    await act(async () => {
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={{ state: "connected", relayOrigin: ORIGIN }} />
        </TooltipProvider>
      );
    });
    expect(checkRelay).toHaveBeenCalledTimes(1);
  });

  it("forgets the last relay's observation and checks the new one when the saved relay changes", async () => {
    const other = "https://other.example.workers.dev";
    const second = deferred<DecisionsRelayCheck>();
    checkRelay
      .mockResolvedValueOnce({ result: "claimed", origin: ORIGIN, compatibility: SAME })
      .mockReturnValueOnce(second.promise);

    const view = renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});
    expect(screen.getByText("decisions.example.workers.dev is claimed")).toBeTruthy();

    await act(async () => {
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={{ state: "connected", relayOrigin: other }} />
        </TooltipProvider>
      );
    });
    expect(screen.queryByText("decisions.example.workers.dev is claimed")).toBeNull();
    expect(checkRelay).toHaveBeenLastCalledWith(other);

    await act(async () => {
      second.resolve({ result: "claimed", origin: other, compatibility: SAME });
    });
    expect(screen.getByText("other.example.workers.dev is claimed")).toBeTruthy();
  });

  it("starts nothing while the switch is changing", async () => {
    renderSection({ state: "not-connected" }, true);

    expect(urlField().disabled).toBe(true);
    fireEvent.change(urlField(), { target: { value: ORIGIN } });
    await act(async () => {
      fireEvent.submit(urlField().form!);
    });

    expect(checkRelay).not.toHaveBeenCalled();
  });

  it("checks the saved relay by itself once connected, and shows the update prompt", async () => {
    checkRelay.mockResolvedValue({
      result: "claimed",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.0.9" },
        daintree: SAME.daintree,
        diverges: true,
      },
    });

    const view = renderSection({ state: "not-connected", relayOrigin: ORIGIN });
    expect(checkRelay).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(ORIGIN)).toBeNull();

    await act(async () => {
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={{ state: "connected", relayOrigin: ORIGIN }} />
        </TooltipProvider>
      );
    });

    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(screen.getByText("The relay needs an update")).toBeTruthy();
    expect(
      screen.getByText(
        /The relay runs 0\.0\.9, protocol 1\. Daintree expects 0\.1\.0, protocol 1\./
      )
    ).toBeTruthy();
    expect(checkButton("Check again")).toBeTruthy();
  });

  it("checks a saved relay that isn't connected only when asked", async () => {
    checkRelay.mockResolvedValue({
      result: "unreachable",
      origin: ORIGIN,
      endpoint: "health",
      reason: "timeout",
    });
    renderSection({ state: "not-connected", relayOrigin: ORIGIN });
    await act(async () => {});
    expect(checkRelay).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(checkButton());
    });

    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(screen.getByText("It didn't answer in time")).toBeTruthy();
  });
});

describe("DecisionsConnectionSection connection state", () => {
  beforeEach(() => {
    checkRelay.mockReset();
    checkRelay.mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, "electron", {
      value: electronStub(),
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  function statusLine(): string {
    return screen.getAllByRole("status")[0]!.textContent ?? "";
  }

  it("names the next attempt's time while reconnecting", () => {
    const nextAttemptAt = new Date(2026, 10, 2, 14, 5, 9).getTime();
    renderSection({ state: "reconnecting", relayOrigin: ORIGIN, nextAttemptAt });

    const clock = new Date(nextAttemptAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    expect(screen.getByText("Reconnecting to decisions.example.workers.dev")).toBeTruthy();
    expect(statusLine()).toContain(`Next attempt at ${clock}`);
  });

  it("warns that another connection replaced this one, with when it tries again", () => {
    const nextAttemptAt = new Date(2026, 10, 2, 14, 9, 0).getTime();
    renderSection({ state: "replaced", relayOrigin: ORIGIN, nextAttemptAt });

    expect(screen.getByText("Replaced by another connection")).toBeTruthy();
    expect(statusLine()).toContain("another copy of Daintree using the same keys");
    expect(statusLine()).toContain(
      new Date(nextAttemptAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  });

  it("says revoked, and offers the disconnect that removes the keys", () => {
    renderSection({ state: "revoked", relayOrigin: ORIGIN });

    expect(screen.getByText("Revoked by decisions.example.workers.dev")).toBeTruthy();
    expect(statusLine()).toContain("won't reconnect");
    expect(screen.getByRole("button", { name: "Disconnect relay" })).toBeTruthy();
  });

  it("says why a relay that's set up isn't being connected to", () => {
    renderSection({ state: "not-connected", relayOrigin: ORIGIN, problem: "other-relay" });
    expect(statusLine()).toContain("came from another relay identity");
    cleanup();

    renderSection({ state: "not-connected", relayOrigin: ORIGIN, problem: "keys" });
    expect(statusLine()).toContain("keys couldn't be read");
  });
});

describe("DecisionsConnectionSection setup unfinished", () => {
  beforeEach(() => {
    checkRelay.mockReset();
    Object.defineProperty(window, "electron", {
      value: electronStub(),
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  function statusRow(): string {
    return document.getElementById("decisions-connection-status")?.textContent ?? "";
  }

  it("warns that setup is unfinished until a recovery kit is verified, keeping the connection's row", () => {
    const nextAttemptAt = new Date(2026, 10, 2, 14, 5, 9).getTime();
    renderSection({ state: "reconnecting", relayOrigin: ORIGIN, nextAttemptAt });

    expect(screen.getByText("Setup isn't finished")).toBeTruthy();
    expect(screen.getByText(/none of it can be recovered/)).toBeTruthy();
    expect(statusRow()).toContain("Reconnecting to decisions.example.workers.dev");
    expect(statusRow()).toContain("Next attempt at");
  });

  it("takes the person to the recovery kit from the warning", () => {
    const onFinishSetup = vi.fn();
    render(
      <TooltipProvider>
        <DecisionsConnectionSection
          status={{ state: "not-connected", relayOrigin: ORIGIN }}
          onFinishSetup={onFinishSetup}
        />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Save recovery kit" }));

    expect(onFinishSetup).toHaveBeenCalledOnce();
  });

  it("warns of nothing once a kit is verified and a setup check passed, or before any relay is set up", () => {
    renderSection({
      state: "not-connected",
      relayOrigin: ORIGIN,
      recoveryKitVerifiedAt: 1,
      setupCheck: { checkedAt: 2, failedStep: null },
    });
    expect(screen.queryByText("Setup isn't finished")).toBeNull();
    cleanup();

    renderSection({ state: "not-connected" });
    expect(screen.queryByText("Setup isn't finished")).toBeNull();
  });

  it("asks for the setup check once the kit is verified, and starts it from the warning", async () => {
    startSetupCheck.mockReturnValue(new Promise(() => {}));
    renderSection({ state: "not-connected", relayOrigin: ORIGIN, recoveryKitVerifiedAt: 1 });

    expect(screen.getByText("Setup isn't finished")).toBeTruthy();
    expect(screen.getByText(/Run the setup check to finish/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save recovery kit" })).toBeNull();

    // The warning's own button, beside the setup check row's.
    const fromWarning = screen
      .getAllByRole("button", { name: "Check setup" })
      .find((button) => !button.hasAttribute("data-decisions-setup-check-start"))!;
    await act(async () => {
      fireEvent.click(fromWarning);
    });
    expect(startSetupCheck).toHaveBeenCalledOnce();
  });

  it("names the step the last setup check stopped at", () => {
    renderSection({
      state: "not-connected",
      relayOrigin: ORIGIN,
      recoveryKitVerifiedAt: 1,
      setupCheck: { checkedAt: 2, failedStep: "push" },
    });

    expect(screen.getByText("Setup isn't finished")).toBeTruthy();
    expect(screen.getByText(/The last setup check stopped at push configuration/)).toBeTruthy();
  });

  it("leaves a revoked relay, or one that can't be used, to say so on its own row", () => {
    renderSection({ state: "revoked", relayOrigin: ORIGIN });
    expect(statusRow()).toContain("Revoked by decisions.example.workers.dev");
    expect(screen.queryByText("Setup isn't finished")).toBeNull();
    cleanup();

    renderSection({ state: "not-connected", relayOrigin: ORIGIN, problem: "keys" });
    expect(statusRow()).toContain("keys couldn't be read");
    expect(screen.queryByText("Setup isn't finished")).toBeNull();
  });
});
