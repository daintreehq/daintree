// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsRelayCheck,
  DecisionsRelayCompatibility,
  DecisionsSetupCheckStartResult,
  DecisionsStatus,
} from "@shared/types/decisions";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsConnectionSection } from "../DecisionsConnectionSection";
import { DecisionsDisconnectDialog } from "../DecisionsDisconnectDialog";

const ORIGIN = "https://decisions.example.workers.dev";
const HOST = "decisions.example.workers.dev";
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

  it("sends a bare host through the form's own submit, leaving the scheme to main", async () => {
    checkRelay.mockResolvedValue({ result: "unclaimed", origin: ORIGIN, compatibility: SAME });
    renderSection({ state: "not-connected" });

    fireEvent.change(urlField(), { target: { value: ORIGIN } });
    expect(urlField().validity.typeMismatch).toBe(false);
    fireEvent.change(urlField(), { target: { value: "decisions.example.workers.dev" } });
    // A URL field holds a bare host as a mismatch of its own, which neither
    // stops the check nor reaches assistive tech as an invalid entry.
    expect(urlField().validity.typeMismatch).toBe(true);
    expect(urlField().getAttribute("aria-invalid")).toBe("false");
    // requestSubmit, unlike a bare submit event, runs the form's own validation first.
    await act(async () => {
      urlField().form!.requestSubmit();
    });
    expect(checkRelay).toHaveBeenCalledExactlyOnceWith("decisions.example.workers.dev");
    expect(urlField().getAttribute("aria-invalid")).toBe("false");
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
    // No protocol in common: the versions row warns.
    const versions = document.getElementById("decisions-relay-versions")!;
    expect(
      versions.querySelector("[data-severity-glyph]")?.classList.contains("lucide-triangle-alert")
    ).toBe(true);
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
    // Nothing was wrong, so the check made on opening added nothing to the page (#18059).
    expect(document.getElementById("decisions-relay-check")).toBeNull();
    expect(document.getElementById("decisions-relay-versions")).toBeNull();
    expect(checkButton("Check")).toBeTruthy();

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
      .mockResolvedValueOnce({
        result: "unreachable",
        origin: ORIGIN,
        endpoint: "health",
        reason: "dns",
      })
      .mockReturnValueOnce(second.promise);

    const view = renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});
    expect(screen.getByText("Couldn't reach decisions.example.workers.dev")).toBeTruthy();

    await act(async () => {
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={{ state: "connected", relayOrigin: other }} />
        </TooltipProvider>
      );
    });
    expect(screen.queryByText("Couldn't reach decisions.example.workers.dev")).toBeNull();
    expect(checkRelay).toHaveBeenLastCalledWith(other);

    await act(async () => {
      second.resolve({ result: "unreachable", origin: other, endpoint: "health", reason: "dns" });
    });
    expect(screen.getByText("Couldn't reach other.example.workers.dev")).toBeTruthy();
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
    // The versions moved apart, which is worth a row; the relay answering as itself isn't.
    expect(document.getElementById("decisions-relay-check")).toBeNull();
    expect(screen.getByText("The relay is behind Daintree")).toBeTruthy();
    // Still asking and answering: information, not a warning.
    const versions = document.getElementById("decisions-relay-versions")!;
    expect(
      within(versions).getByText(
        /The relay runs 0\.0\.9, protocol 1\. Daintree expects 0\.1\.0, protocol 1\. Both speak protocol 1, so questions and answers work\./
      )
    ).toBeTruthy();
    expect(versions.querySelector("[data-severity-glyph]")?.classList.contains("lucide-info")).toBe(
      true
    );
    expect(checkButton("Check again")).toBeTruthy();
  });

  it("shows the whole check of the relay set up here on Check, without calling it someone else's", async () => {
    const asked = deferred<DecisionsRelayCheck>();
    checkRelay
      .mockResolvedValueOnce({
        result: "claimed",
        origin: ORIGIN,
        compatibility: {
          relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.0.9" },
          daintree: SAME.daintree,
          diverges: true,
        },
      })
      .mockReturnValueOnce(asked.promise);
    renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});
    expect(document.getElementById("decisions-relay-check")).toBeNull();
    expect(screen.getByText("The relay is behind Daintree")).toBeTruthy();

    await act(async () => {
      fireEvent.click(checkButton("Check again"));
    });
    const regions = () => screen.getAllByRole("status").map((region) => region.textContent ?? "");
    expect(regions()).toContain("Checking the relay…");
    expect(checkButton("Check again").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      asked.resolve({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    });

    expect(checkRelay).toHaveBeenCalledTimes(2);
    const row = document.getElementById("decisions-relay-check")!;
    expect(row.textContent).toContain(
      "decisions.example.workers.dev answered as a Decisions relay"
    );
    expect(row.textContent).toContain("the relay this computer is set up with");
    expect(row.textContent).not.toMatch(/already has an owner|is claimed/);
    // What the person asked for, not what the check on opening saw.
    expect(screen.getByText("Relay and Daintree versions match")).toBeTruthy();
    expect(screen.queryByText("The relay is behind Daintree")).toBeNull();
    expect(checkButton("Check again")).toBeTruthy();
  });

  it("says a version mismatch found on opening when it's the only row it adds", async () => {
    checkRelay.mockResolvedValue({
      result: "claimed",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.2.0" },
        daintree: SAME.daintree,
        diverges: true,
      },
    });
    renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});

    expect(document.getElementById("decisions-relay-check")).toBeNull();
    expect(screen.getByText("The relay is newer than Daintree")).toBeTruthy();
    const announced = screen
      .getAllByRole("status")
      .some((region) => region.textContent?.startsWith("The relay is newer than Daintree."));
    expect(announced).toBe(true);
  });

  it("keeps a failed check the person asked for while the connection comes back and checks again", async () => {
    const retry = deferred<DecisionsRelayCheck>();
    checkRelay
      .mockResolvedValueOnce({ result: "claimed", origin: ORIGIN, compatibility: SAME })
      .mockRejectedValueOnce(new Error("Turn on Decisions to check a relay"))
      .mockReturnValueOnce(retry.promise);
    const view = renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});
    await act(async () => {
      fireEvent.click(checkButton("Check"));
    });
    const failed = () => document.getElementById("decisions-relay-url")!.textContent ?? "";
    expect(failed()).toContain("Couldn't check the relay. Turn on Decisions");

    const rerender = (status: DecisionsStatus) =>
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={status} />
        </TooltipProvider>
      );
    await act(async () => rerender({ state: "reconnecting", relayOrigin: ORIGIN }));
    await act(async () => rerender({ state: "connected", relayOrigin: ORIGIN }));
    expect(checkRelay).toHaveBeenCalledTimes(3);
    expect(failed()).toContain("Couldn't check the relay. Turn on Decisions");
    expect(checkButton("Check again")).toBeTruthy();

    await act(async () => {
      retry.resolve({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    });
    expect(failed()).not.toContain("Couldn't check the relay");
    // The person asked about this relay, so its answer shows in full.
    expect(screen.getByText("Relay and Daintree versions match")).toBeTruthy();
  });

  it("adds a row on opening only for what's wrong, and says it", async () => {
    checkRelay.mockResolvedValue({
      result: "unreachable",
      origin: ORIGIN,
      endpoint: "health",
      reason: "timeout",
    });
    renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});

    const row = document.getElementById("decisions-relay-check")!;
    expect(within(row).getByText("Couldn't reach decisions.example.workers.dev")).toBeTruthy();
    expect(within(row).getByText("It didn't answer in time")).toBeTruthy();
    const announced = screen
      .getAllByRole("status")
      .map((region) => region.textContent ?? "")
      .some((text) => text.startsWith("Couldn't reach decisions.example.workers.dev"));
    expect(announced).toBe(true);
    expect(checkButton("Check again")).toBeTruthy();
  });

  it("warns on opening when the relay set up here reports no owner", async () => {
    checkRelay.mockResolvedValue({ result: "unclaimed", origin: ORIGIN, compatibility: SAME });
    renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});

    const row = document.getElementById("decisions-relay-check")!;
    expect(within(row).getByText("decisions.example.workers.dev reports no owner")).toBeTruthy();
    expect(row.textContent).toContain("it answered as one nobody has claimed");
    expect(
      row.querySelector("[data-severity-glyph]")?.classList.contains("lucide-triangle-alert")
    ).toBe(true);
    expect(row.textContent).not.toMatch(/ready to claim/);
    expect(document.getElementById("decisions-relay-versions")).toBeNull();
  });

  it("says nothing while it checks on opening, or once it found nothing wrong", async () => {
    const pending = deferred<DecisionsRelayCheck>();
    checkRelay.mockReturnValue(pending.promise);
    renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});

    const regions = () => screen.getAllByRole("status").map((region) => region.textContent ?? "");
    expect(regions()).not.toContain("Checking the relay…");
    expect(checkButton("Check").getAttribute("aria-busy")).not.toBe("true");

    await act(async () => {
      pending.resolve({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    });
    expect(regions().filter((text) => text !== "")).toEqual([
      "Connected to decisions.example.workers.dev",
    ]);
  });

  it("lets a check the person asked for win over the one made on opening, whichever answers last", async () => {
    const opening = deferred<DecisionsRelayCheck>();
    const asked = deferred<DecisionsRelayCheck>();
    checkRelay.mockReturnValueOnce(opening.promise).mockReturnValueOnce(asked.promise);
    const view = renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});

    await act(async () => {
      fireEvent.click(checkButton("Check"));
    });
    // The connection drops and comes back while the asked-for check is out: it isn't replaced.
    const rerender = (status: DecisionsStatus) =>
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={status} />
        </TooltipProvider>
      );
    await act(async () => rerender({ state: "reconnecting", relayOrigin: ORIGIN }));
    await act(async () => rerender({ state: "connected", relayOrigin: ORIGIN }));
    expect(checkRelay).toHaveBeenCalledTimes(2);

    // The opening's answer arrives first and is dropped: the asked-for check is still out.
    await act(async () => {
      opening.resolve({ result: "unreachable", origin: ORIGIN, endpoint: "health", reason: "dns" });
    });
    expect(screen.queryByText("Couldn't reach decisions.example.workers.dev")).toBeNull();
    expect(checkButton("Check").getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      asked.resolve({ result: "claimed", origin: ORIGIN, compatibility: SAME });
    });

    expect(
      screen.getByText("decisions.example.workers.dev answered as a Decisions relay")
    ).toBeTruthy();
    expect(screen.getByText("Relay and Daintree versions match")).toBeTruthy();
    expect(screen.queryByText("Couldn't reach decisions.example.workers.dev")).toBeNull();
  });

  it("keeps the whole check the person asked for when the connection comes back and checks again", async () => {
    checkRelay
      .mockResolvedValueOnce({ result: "claimed", origin: ORIGIN, compatibility: SAME })
      .mockResolvedValueOnce({ result: "claimed", origin: ORIGIN, compatibility: SAME })
      .mockResolvedValueOnce({
        result: "claimed",
        origin: ORIGIN,
        compatibility: {
          relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.1" },
          daintree: SAME.daintree,
          diverges: true,
        },
      });
    const view = renderSection({ state: "connected", relayOrigin: ORIGIN });
    await act(async () => {});
    await act(async () => {
      fireEvent.click(checkButton("Check"));
    });
    expect(screen.getByText("Relay and Daintree versions match")).toBeTruthy();

    const rerender = (status: DecisionsStatus) =>
      view.rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={status} />
        </TooltipProvider>
      );
    await act(async () => rerender({ state: "reconnecting", relayOrigin: ORIGIN }));
    await act(async () => rerender({ state: "connected", relayOrigin: ORIGIN }));

    expect(checkRelay).toHaveBeenCalledTimes(3);
    // The new answer, in full: the relay row stays, and the versions say what changed.
    expect(screen.getByText("The relay is newer than Daintree")).toBeTruthy();
    expect(screen.queryByText("Relay and Daintree versions match")).toBeNull();
    expect(document.getElementById("decisions-relay-check")).toBeTruthy();
  });

  it("shows what was observed about the rest of Decisions under the status, only while connected", () => {
    checkRelay.mockReturnValue(new Promise(() => {}));
    const facts = <span>2 phones with notifications</span>;
    const view = render(
      <TooltipProvider>
        <DecisionsConnectionSection
          status={{ state: "connected", relayOrigin: ORIGIN }}
          facts={facts}
        />
      </TooltipProvider>
    );
    const statusRow = () => document.getElementById("decisions-connection-status")!;
    expect(within(statusRow()).getByText("2 phones with notifications")).toBeTruthy();
    // Not part of what the status announces.
    expect(screen.getAllByRole("status")[0]!.textContent).toBe(
      "Connected to decisions.example.workers.dev"
    );

    view.rerender(
      <TooltipProvider>
        <DecisionsConnectionSection
          status={{ state: "reconnecting", relayOrigin: ORIGIN }}
          facts={facts}
        />
      </TooltipProvider>
    );
    expect(within(statusRow()).queryByText("2 phones with notifications")).toBeNull();
    expect(statusRow().textContent).toContain("The connection closed");
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

describe("DecisionsConnectionSection disconnect focus", () => {
  const disconnectRelay = vi.fn<() => Promise<DecisionsStatus>>();

  /** The tab's part: the status main answers with replaces the one shown. */
  function Section({ initial }: { initial: DecisionsStatus }) {
    const [status, setStatus] = useState(initial);
    return (
      <TooltipProvider>
        <DecisionsConnectionSection
          status={status}
          onChanged={(next) => {
            if (next) setStatus(next);
          }}
        />
      </TooltipProvider>
    );
  }

  beforeEach(() => {
    checkRelay.mockReset();
    startSetupCheck.mockReset();
    disconnectRelay.mockReset();
    const stub = electronStub();
    Object.defineProperty(window, "electron", {
      value: { ...stub, decisions: { ...stub.decisions, disconnectRelay } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it.each<[string, DecisionsStatus, string, string | null]>([
    [
      "a relay with a current kit",
      {
        state: "not-connected",
        relayOrigin: ORIGIN,
        keysStored: true,
        recoveryKitVerifiedAt: 1,
        recoveryKitCurrent: true,
      },
      "Disconnect relay",
      null,
    ],
    [
      "a relay with no current kit",
      { state: "not-connected", relayOrigin: ORIGIN, keysStored: true },
      "Disconnect relay",
      HOST,
    ],
    [
      "an unfinished setup's keys",
      { state: "not-connected", keysStored: true },
      "Remove keys",
      "Decisions keys",
    ],
  ])(
    "hands focus to the relay URL field once removing %s takes its button away",
    async (_, initial, label, typed) => {
      disconnectRelay.mockResolvedValue({ state: "not-connected" });
      render(<Section initial={initial} />);
      await act(async () => {});

      const trigger = screen.getByRole("button", { name: label });
      trigger.focus();
      fireEvent.click(trigger);
      const confirm = within(screen.getByRole("alertdialog")).getByRole("button", {
        name: label,
      });
      if (typed !== null) {
        fireEvent.change(within(screen.getByRole("alertdialog")).getByRole("textbox"), {
          target: { value: typed },
        });
      }
      act(() => confirm.focus());
      await act(async () => {
        fireEvent.click(confirm);
      });

      expect(disconnectRelay).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.queryByRole("button", { name: label })).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(urlField()));
    }
  );

  it("hands focus back to Disconnect relay when the confirm is cancelled", async () => {
    render(<Section initial={{ state: "not-connected", relayOrigin: ORIGIN }} />);
    await act(async () => {});

    const trigger = screen.getByRole("button", { name: "Disconnect relay" });
    trigger.focus();
    fireEvent.click(trigger);
    const cancel = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" });
    act(() => cancel.focus());
    fireEvent.click(cancel);

    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(disconnectRelay).not.toHaveBeenCalled();
  });
});

describe("DecisionsDisconnectDialog safeguard (#18064)", () => {
  afterEach(() => {
    cleanup();
  });

  function renderDialog(props: { relayOrigin: string | null; kitCurrent: boolean }) {
    const onConfirm = vi.fn();
    const view = render(
      <DecisionsDisconnectDialog
        isOpen
        disconnecting={false}
        error={null}
        onCancel={() => {}}
        onConfirm={onConfirm}
        {...props}
      />
    );
    return { onConfirm, view };
  }

  function confirmButton(name = "Disconnect relay"): HTMLButtonElement {
    return within(screen.getByRole("alertdialog")).getByRole("button", {
      name,
    }) as HTMLButtonElement;
  }

  function unavailable(element: HTMLElement): boolean {
    return (
      element.getAttribute("aria-disabled") === "true" || (element as HTMLButtonElement).disabled
    );
  }

  it("asks for one click while a current kit holds the keys", () => {
    const { onConfirm } = renderDialog({ relayOrigin: ORIGIN, kitCurrent: true });

    expect(within(screen.getByRole("alertdialog")).queryByRole("textbox")).toBeNull();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("asks for the relay's address with no current kit, naming what can't be got back", () => {
    const { onConfirm } = renderDialog({ relayOrigin: ORIGIN, kitCurrent: false });
    const body = screen.getByRole("alertdialog").textContent ?? "";

    expect(body).toContain(`only copy of ${HOST}'s owner keys`);
    expect(body).toContain(`${HOST}'s past questions and answers unreadable`);
    expect(body).toContain("Save and verify a recovery kit first");
    expect(unavailable(confirmButton())).toBe(true);
    fireEvent.click(confirmButton());

    const field = within(screen.getByRole("alertdialog")).getByRole("textbox");
    fireEvent.change(field, { target: { value: "decisions.example" } });
    expect(unavailable(confirmButton())).toBe(true);
    fireEvent.change(field, { target: { value: HOST } });
    expect(unavailable(confirmButton())).toBe(false);
    fireEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("asks for the keys' name for an unfinished setup's keys, which no kit can cover", () => {
    const { onConfirm } = renderDialog({ relayOrigin: null, kitCurrent: true });

    expect(unavailable(confirmButton("Remove keys"))).toBe(true);
    expect(screen.getByRole("alertdialog").textContent).not.toContain("Save and verify");
    fireEvent.change(within(screen.getByRole("alertdialog")).getByRole("textbox"), {
      target: { value: "Decisions keys" },
    });
    fireEvent.click(confirmButton("Remove keys"));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("puts the gate up while open when the kit stops covering the keys, and takes it down when one does", () => {
    const { onConfirm, view } = renderDialog({ relayOrigin: ORIGIN, kitCurrent: true });
    const rerender = (kitCurrent: boolean) =>
      view.rerender(
        <DecisionsDisconnectDialog
          isOpen
          relayOrigin={ORIGIN}
          kitCurrent={kitCurrent}
          disconnecting={false}
          error={null}
          onCancel={() => {}}
          onConfirm={onConfirm}
        />
      );

    rerender(false);
    expect(unavailable(confirmButton())).toBe(true);
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(true);
    expect(within(screen.getByRole("alertdialog")).queryByRole("textbox")).toBeNull();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
