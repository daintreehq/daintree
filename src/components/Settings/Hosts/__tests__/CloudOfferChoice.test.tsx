// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  CloudCreateOffer,
  CloudCreateOfferChoice,
  CloudOfferBidder,
} from "@shared/types/cloudHosts";

const { client } = vi.hoisted(() => ({
  client: {
    chooseOffer: vi.fn(),
    cancelOrder: vi.fn(),
    refreshOffers: vi.fn(),
    createHost: vi.fn(),
    retryCreate: vi.fn(),
  },
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: client }));

import { CloudOfferChoice, OFFER_WAIT_MS } from "../CloudOfferChoice";
import { ClientAppError } from "@/utils/clientAppError";

const T0 = 1_750_000_000_000;

function offer(
  id: string,
  hourlyDollars: number,
  bidder: Partial<CloudOfferBidder> = {},
  reason: string | null = null
): CloudCreateOffer {
  const base = {
    id,
    hourlyDollars,
    bidder: { id: `akash1${id}`, name: `Bidder ${id}`, region: null, ...bidder },
  };
  return reason === null
    ? { ...base, choosable: true, reason: null }
    : { ...base, choosable: false, reason };
}

function pending(overrides: Partial<CloudCreateOfferChoice> = {}): CloudCreateOfferChoice {
  return {
    kind: "awaiting-offer",
    order: { id: "dseq-1" },
    waitingSince: T0,
    offers: [],
    offersReadAt: null,
    ...overrides,
  };
}

const ui = (choice: CloudCreateOfferChoice) => (
  <CloudOfferChoice hostId="build" choice={choice} name="offer" />
);

const radio = (bidder: string) => screen.getByRole("radio", { name: bidder }) as HTMLInputElement;
const radioNames = () =>
  screen
    .getAllByRole("radio")
    .map((input) => input.getAttribute("aria-labelledby") ?? "")
    .map((id) => document.getElementById(id)?.textContent);
const describedBy = (input: HTMLElement) =>
  (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .filter(Boolean)
    .join(" ");
const rowText = (bidder: string) => radio(bidder).closest("label")?.textContent ?? "";
const button = (label: string) =>
  screen.queryByRole("button", { name: label }) as HTMLButtonElement | null;
const waitingShown = () => screen.queryByTestId("cloud-offer-waiting") !== null;
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const settle = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CloudOfferChoice while offers come in", () => {
  it("shows nothing at first, then offer-shaped rows, then says it's still working", () => {
    render(ui(pending()));
    // The way out is there from the start; there is nothing to lease yet.
    expect(button("Cancel order")).toBeTruthy();
    expect(button("Lease offer")).toBeNull();
    advance(399);
    expect(waitingShown()).toBe(false);
    advance(1);
    expect(waitingShown()).toBe(true);
    expect(screen.queryByTestId("cloud-offer-still-working")).toBeNull();
    advance(5000 - 400);
    expect(screen.getByTestId("cloud-offer-still-working").textContent).toBe("Still working…");
  });

  it("says none came once the wait is over, however often an empty list was read", () => {
    const view = render(ui(pending({ offersReadAt: T0 + 1000 })));
    advance(20_000);
    view.rerender(ui(pending({ offersReadAt: T0 + 20_000 })));
    advance(OFFER_WAIT_MS - 20_000 - 1);
    expect(screen.queryByTestId("cloud-offer-none")).toBeNull();
    advance(1);
    expect(screen.getByTestId("cloud-offer-none").textContent).toContain(
      "No offers have arrived yet."
    );
    expect(waitingShown()).toBe(false);
    expect(button("Retry")).toBeTruthy();
    expect(button("Cancel order")).toBeTruthy();
  });

  it("counts the wait from when this device began waiting, so a late look says so at once", () => {
    vi.setSystemTime(T0 + OFFER_WAIT_MS + 1000);
    render(ui(pending()));
    expect(screen.getByTestId("cloud-offer-none").textContent).toContain(
      "Daintree hasn't heard back about the order yet."
    );
    expect(waitingShown()).toBe(false);
  });

  it("shows the first offer the moment it arrives, after the wait too", () => {
    vi.setSystemTime(T0 + OFFER_WAIT_MS + 1000);
    const view = render(ui(pending({ offersReadAt: T0 + 1000 })));
    view.rerender(ui(pending({ offersReadAt: T0 + 40_000, offers: [offer("a", 0.03)] })));
    expect(screen.queryByTestId("cloud-offer-none")).toBeNull();
    expect(radio("Bidder a")).toBeTruthy();
  });

  it("reads the same order again on Retry, and waits afresh from then", async () => {
    vi.setSystemTime(T0 + OFFER_WAIT_MS + 1000);
    client.refreshOffers.mockResolvedValue(undefined);
    render(ui(pending({ offersReadAt: T0 + 1000 })));
    fireEvent.click(button("Retry")!);
    await settle();
    expect(client.refreshOffers).toHaveBeenCalledTimes(1);
    expect(client.refreshOffers).toHaveBeenCalledWith("build", "dseq-1");
    expect(client.createHost).not.toHaveBeenCalled();
    expect(client.retryCreate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cloud-offer-none")).toBeNull();
    advance(400);
    expect(waitingShown()).toBe(true);
    // Each deadline is set once the one before it has been shown.
    advance(5000 - 400);
    expect(screen.getByTestId("cloud-offer-still-working")).toBeTruthy();
    advance(OFFER_WAIT_MS - 5000 - 1);
    expect(screen.queryByTestId("cloud-offer-none")).toBeNull();
    advance(1);
    expect(screen.getByTestId("cloud-offer-none")).toBeTruthy();
  });

  it("keeps the message and says why when Retry is refused", async () => {
    vi.setSystemTime(T0 + OFFER_WAIT_MS + 1000);
    client.refreshOffers.mockRejectedValue(
      new ClientAppError("OUTCOME_UNKNOWN", "refused", "Akash didn't answer.")
    );
    render(ui(pending({ offersReadAt: T0 + 1000 })));
    fireEvent.click(button("Retry")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Akash didn't answer.");
    expect(screen.getByTestId("cloud-offer-none")).toBeTruthy();
    expect(button("Retry")!.disabled).toBe(false);
  });

  it("leaves no timer behind once it goes", () => {
    const view = render(ui(pending()));
    advance(1000);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CloudOfferChoice offers", () => {
  const mixed = () =>
    pending({
      offersReadAt: T0 + 8000,
      offers: [
        offer("b", 0.05, { name: "Hurricane", uptimePercent: 0 }),
        offer("c", 0.02, { name: "Cheapo", region: "us-east" }, "not on your trusted list"),
        offer("a", 0.036, {
          name: "Europlots",
          region: "eu-west",
          uptimePercent: 99.87,
          audited: true,
        }),
      ],
    });

  it("prices each offer by the hour and the month, with its bidder, region, uptime and audit", () => {
    render(ui(mixed()));
    expect(describedBy(radio("Europlots"))).toBe("$0.036 an hour · about $26.28 a month");
    expect(rowText("Europlots")).toContain("eu-west · 99.9% uptime");
    expect(rowText("Europlots")).toContain("Audited");
    // An uptime of nothing is still said; a region or audit the provider doesn't give isn't.
    expect(rowText("Hurricane")).toContain("0% uptime");
    expect(rowText("Hurricane")).not.toContain("Audited");
    expect(rowText("Cheapo")).not.toContain("uptime");
  });

  it("shows an offer that can't be chosen disabled, saying why, after those that can", () => {
    render(ui(mixed()));
    expect(radioNames()).toEqual(["Europlots", "Hurricane", "Cheapo"]);
    expect(radio("Cheapo").disabled).toBe(true);
    expect(describedBy(radio("Cheapo"))).toBe("Not on your trusted list");
    expect(rowText("Cheapo")).toContain("$0.020 an hour · about $14.60 a month · us-east");
    expect(radio("Europlots").disabled).toBe(false);
  });

  it("lists every offer even when none can be chosen, so the list explains itself", () => {
    render(
      ui(
        pending({
          offers: [
            offer("a", 0.03, { name: "First" }, "not on your trusted list"),
            offer("b", 0.04, { name: "Second" }, "not audited"),
          ],
        })
      )
    );
    expect(radio("First").disabled).toBe(true);
    expect(radio("Second").disabled).toBe(true);
    expect(button("Lease offer")!.disabled).toBe(true);
    expect(screen.queryByTestId("cloud-offer-none")).toBeNull();
  });
});

describe("CloudOfferChoice leasing and cancelling", () => {
  const two = (a = 0.036) =>
    pending({
      offersReadAt: T0 + 8000,
      offers: [offer("a", a, { name: "Europlots" }), offer("b", 0.05, { name: "Hurricane" })],
    });

  it("leases the offer picked, of the order shown", async () => {
    client.chooseOffer.mockResolvedValue(undefined);
    render(ui(two()));
    expect(button("Lease offer")!.disabled).toBe(true);
    fireEvent.click(radio("Hurricane"));
    fireEvent.click(button("Lease offer")!);
    await settle();
    expect(client.chooseOffer).toHaveBeenCalledTimes(1);
    expect(client.chooseOffer).toHaveBeenCalledWith("build", "dseq-1", "b");
  });

  it("keeps a pick across a reorder, drops it when its quote moves or it goes, and never brings it back", () => {
    const view = render(ui(two()));
    fireEvent.click(radio("Europlots"));
    view.rerender(
      ui(
        pending({
          offers: [
            offer("b", 0.05, { name: "Hurricane" }),
            offer("a", 0.036, { name: "Europlots" }),
          ],
        })
      )
    );
    expect(radio("Europlots").checked).toBe(true);

    view.rerender(ui(two(0.04)));
    expect(radio("Europlots").checked).toBe(false);
    expect(button("Lease offer")!.disabled).toBe(true);
    expect(screen.getByTestId("cloud-offer-choice-lost")).toBeTruthy();

    view.rerender(ui(two()));
    expect(radio("Europlots").checked).toBe(false);

    fireEvent.click(radio("Europlots"));
    expect(screen.queryByTestId("cloud-offer-choice-lost")).toBeNull();
    view.rerender(ui(pending({ offers: [offer("b", 0.05, { name: "Hurricane" })] })));
    expect(radio("Hurricane").checked).toBe(false);
    expect(screen.getByTestId("cloud-offer-choice-lost")).toBeTruthy();
  });

  it("says why a lease was refused and leaves the other offers to choose", async () => {
    client.chooseOffer.mockRejectedValue(
      new ClientAppError("NOT_FOUND", "gone", "That offer was withdrawn. Choose another.")
    );
    render(ui(two()));
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Lease offer")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("That offer was withdrawn. Choose another.");
    expect(radio("Europlots").checked).toBe(false);
    expect(radio("Hurricane").disabled).toBe(false);
    expect(button("Lease offer")!.disabled).toBe(true);
    expect(button("Cancel order")!.disabled).toBe(false);
  });

  it("holds both actions once a lease went through, until the order's next state arrives", async () => {
    client.chooseOffer.mockResolvedValue(undefined);
    const view = render(ui(two()));
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Lease offer")!);
    await settle();
    expect(button("Lease offer")!.disabled).toBe(true);
    expect(button("Cancel order")!.disabled).toBe(true);
    fireEvent.click(button("Cancel order")!);
    expect(client.cancelOrder).not.toHaveBeenCalled();

    view.rerender(ui(two()));
    expect(button("Cancel order")!.disabled).toBe(false);
  });

  it("cancels the order shown, and says why when it couldn't", async () => {
    client.cancelOrder.mockRejectedValueOnce(
      new ClientAppError("OUTCOME_UNKNOWN", "lost", "Akash didn't confirm the close yet.")
    );
    render(ui(pending()));
    fireEvent.click(button("Cancel order")!);
    await settle();
    expect(client.cancelOrder).toHaveBeenCalledWith("build", "dseq-1");
    expect(screen.getByRole("alert").textContent).toBe("Akash didn't confirm the close yet.");
    expect(button("Cancel order")!.disabled).toBe(false);
  });
});
