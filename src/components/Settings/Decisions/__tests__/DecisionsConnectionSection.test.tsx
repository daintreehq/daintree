// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsRelayCheck,
  DecisionsRelayCompatibility,
  DecisionsStatus,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsConnectionSection } from "../DecisionsConnectionSection";

const ORIGIN = "https://decisions.example.workers.dev";
const checkRelay = vi.fn<(url: string) => Promise<DecisionsRelayCheck>>();

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
      value: { decisions: { checkRelay } },
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
