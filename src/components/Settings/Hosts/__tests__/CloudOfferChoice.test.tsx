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

import { CloudOfferChoice } from "../CloudOfferChoice";
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

const ui = (choice: CloudCreateOfferChoice, problem: string | null = null) => (
  <CloudOfferChoice
    hostId="build"
    choice={choice}
    name="offer"
    surface="dialog"
    problem={problem}
  />
);

const radio = (bidder: string) => screen.getByRole("radio", { name: bidder }) as HTMLInputElement;
const radios = () => screen.queryAllByRole("radio") as HTMLInputElement[];
const radioNames = () =>
  radios().map(
    (input) => document.getElementById(input.getAttribute("aria-labelledby") ?? "")?.textContent
  );
const describedBy = (input: HTMLElement) =>
  (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .filter(Boolean)
    .join(" ");
const rowText = (bidder: string) => radio(bidder).closest("label")?.textContent ?? "";
const button = (label: string) =>
  screen.queryByRole("button", { name: label }) as HTMLButtonElement | null;
const unavailable = (label: string) => {
  const found = button(label)!;
  return found.disabled || found.getAttribute("aria-disabled") === "true";
};
const bones = () => document.querySelectorAll("[data-skeleton-bone]").length;
const noneText = () => screen.queryByTestId("cloud-offer-none")?.textContent ?? null;
const slowShown = () => screen.queryByTestId("cloud-offer-still-working") !== null;
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const settle = () => act(async () => {});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CloudOfferChoice while offers come in", () => {
  it("shows nothing at first, then two offer-shaped rows, then says it's still working", () => {
    render(ui(pending()));
    // The way out is there from the start; there is nothing to lease yet.
    expect(button("Cancel order")).toBeTruthy();
    expect(button("Lease offer")).toBeNull();
    advance(399);
    expect(bones()).toBe(0);
    advance(1);
    expect(bones()).toBe(2);
    advance(4999 - 400);
    expect(slowShown()).toBe(false);
    advance(1);
    expect(screen.getByTestId("cloud-offer-still-working").textContent).toBe("Still working…");
  });

  it("says none came 30 seconds after the order, however often an empty list was read", () => {
    const view = render(ui(pending({ offersReadAt: T0 })));
    advance(20_000);
    view.rerender(ui(pending({ offersReadAt: T0 + 20_000 })));
    advance(9_999);
    expect(noneText()).toBeNull();
    advance(1);
    expect(noneText()).toContain("No offers have arrived yet.");
    expect(bones()).toBe(0);
    expect(button("Retry")).toBeTruthy();
    expect(button("Cancel order")).toBeTruthy();
  });

  it("counts from when this device began waiting, so a late look says so at once", () => {
    vi.setSystemTime(T0 + 31_000);
    const view = render(ui(pending()));
    expect(noneText()).toContain("Daintree hasn't heard back about the order yet.");
    expect(bones()).toBe(0);
    // A read that finds nothing changes what's said, not when.
    view.rerender(ui(pending({ offersReadAt: T0 + 31_000 })));
    expect(noneText()).toContain("No offers have arrived yet.");
  });

  it("shows a first offer the moment it arrives, after the wait too", () => {
    vi.setSystemTime(T0 + 31_000);
    const view = render(ui(pending({ offersReadAt: T0 + 1000 })));
    view.rerender(ui(pending({ offersReadAt: T0 + 31_000, offers: [offer("a", 0.03)] })));
    expect(noneText()).toBeNull();
    expect(radio("Bidder a")).toBeTruthy();
  });

  it("never flashes the rows for an offer that beats the gate, and holds them once shown", () => {
    const early = render(ui(pending()));
    advance(399);
    early.rerender(ui(pending({ offers: [offer("a", 0.03)], offersReadAt: T0 + 399 })));
    expect(bones()).toBe(0);
    expect(radios()).toHaveLength(1);
    early.unmount();

    vi.setSystemTime(T0);
    const late = render(ui(pending()));
    advance(400);
    advance(50);
    expect(bones()).toBe(2);
    late.rerender(ui(pending({ offers: [offer("a", 0.03)], offersReadAt: T0 + 450 })));
    // Shown at 400 ms, the rows stay up for their floor before the offer replaces them.
    advance(199);
    expect(bones()).toBe(2);
    expect(radios()).toHaveLength(0);
    advance(1);
    expect(bones()).toBe(0);
    expect(radios()).toHaveLength(1);
  });

  it("goes back to waiting when every offer is withdrawn, and says so once the wait is over", () => {
    const view = render(ui(pending({ offers: [offer("a", 0.03, { name: "Solo" })] })));
    fireEvent.click(radio("Solo"));
    advance(10_000);
    view.rerender(ui(pending({ offersReadAt: T0 + 10_000 })));
    advance(0);
    // Each timer is set once the commit before it lands, so the gate gets its own step.
    advance(400);
    expect(radios()).toHaveLength(0);
    expect(button("Lease offer")).toBeNull();
    // Nothing left to pick, so it doesn't ask for another pick.
    expect(screen.getByTestId("cloud-offer-choice-lost").textContent).toBe(
      "The offer you picked changed or was withdrawn."
    );
    advance(19_599);
    expect(noneText()).toBeNull();
    advance(1);
    expect(noneText()).toContain("Its offers were withdrawn");
    view.rerender(
      ui(pending({ offersReadAt: T0 + 40_000, offers: [offer("a", 0.03, { name: "Solo" })] }))
    );
    expect(radio("Solo").checked).toBe(false);
  });

  it("reads the same order again on Retry, and waits afresh from the click", async () => {
    vi.setSystemTime(T0 + 31_000);
    const answer = deferred();
    client.refreshOffers.mockReturnValue(answer.promise);
    render(ui(pending({ offersReadAt: T0 + 1000 })));
    fireEvent.click(button("Retry")!);
    expect(button("Retry")!.getAttribute("aria-busy")).toBe("true");
    advance(2000);
    await act(async () => answer.resolve());
    expect(client.refreshOffers).toHaveBeenCalledTimes(1);
    expect(client.refreshOffers).toHaveBeenCalledWith("build", "dseq-1");
    expect(client.createHost).not.toHaveBeenCalled();
    expect(client.retryCreate).not.toHaveBeenCalled();
    expect(noneText()).toBeNull();
    advance(2999);
    expect(slowShown()).toBe(false);
    advance(1);
    expect(slowShown()).toBe(true);
    advance(24_999);
    expect(noneText()).toBeNull();
    advance(1);
    expect(noneText()).not.toBeNull();
  });

  it("keeps the message when Retry is refused, and clears the refusal when asked again", async () => {
    vi.setSystemTime(T0 + 31_000);
    client.refreshOffers.mockRejectedValueOnce(
      new ClientAppError("OUTCOME_UNKNOWN", "refused", "Akash didn't answer.")
    );
    const view = render(ui(pending({ offersReadAt: T0 + 1000 })));
    fireEvent.click(button("Retry")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Akash didn't answer.");
    expect(noneText()).not.toBeNull();
    expect(unavailable("Retry")).toBe(false);

    const second = deferred();
    client.refreshOffers.mockReturnValueOnce(second.promise);
    fireEvent.click(button("Retry")!);
    expect(screen.queryByRole("alert")).toBeNull();
    // An offer arrives while the second ask is out; its refusal doesn't take the offer away.
    view.rerender(
      ui(pending({ offersReadAt: T0 + 31_500, offers: [offer("a", 0.03, { name: "Europlots" })] }))
    );
    await act(async () =>
      second.reject(new ClientAppError("OUTCOME_UNKNOWN", "refused", "Still no answer."))
    );
    expect(screen.getByRole("alert").textContent).toBe("Still no answer.");
    expect(noneText()).toBeNull();
    expect(button("Retry")).toBeNull();
    client.chooseOffer.mockResolvedValue(undefined);
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Lease offer")!);
    await settle();
    expect(client.chooseOffer).toHaveBeenCalledWith("build", "dseq-1", "a", 0.03);
  });

  it.each([
    ["before the rows show", 200],
    ["after it says it's still working", 5200],
  ])("leaves no timer behind once it goes %s", (_when, ms) => {
    const before = vi.getTimerCount();
    const view = render(ui(pending()));
    advance(ms);
    view.unmount();
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe("CloudOfferChoice offers", () => {
  const mixed = () =>
    pending({
      offersReadAt: T0 + 8000,
      offers: [
        offer("b", 0.05, { name: "Hurricane", uptimePercent: 0, audited: false }),
        offer("c", 0.02, { name: "Cheapo", region: "us-east" }, "not on your trusted list"),
        offer("a", 0.036, {
          name: "Europlots",
          region: "eu-west",
          uptimePercent: 99.87,
          audited: true,
        }),
        offer("d", 0.07, { name: "Quiet" }),
      ],
    });

  it("prices each offer by the hour and the month, with its bidder, region, uptime and audit", () => {
    render(ui(mixed()));
    expect(describedBy(radio("Europlots"))).toBe("$0.036 an hour · about $26.28 a month");
    expect(describedBy(radio("Hurricane"))).toBe("$0.050 an hour · about $36.50 a month");
    expect(rowText("Europlots")).toContain("eu-west · 99.9% uptime");
    expect(rowText("Europlots")).toContain("Audited");
    // An uptime of nothing is still said; a region, uptime or audit not given isn't.
    expect(rowText("Hurricane")).toContain("0% uptime");
    expect(rowText("Hurricane")).not.toContain("Audited");
    expect(rowText("Quiet")).not.toContain("Audited");
    expect(rowText("Quiet")).not.toContain("uptime");
    expect(rowText("Cheapo")).not.toContain("uptime");
  });

  it("shows an offer that can't be chosen disabled, saying why, after those that can", () => {
    render(ui(mixed()));
    expect(radioNames()).toEqual(["Europlots", "Hurricane", "Quiet", "Cheapo"]);
    expect(radio("Cheapo").disabled).toBe(true);
    expect(describedBy(radio("Cheapo"))).toBe("Not on your trusted list");
    expect(rowText("Cheapo")).toContain("$0.020 an hour · about $14.60 a month · us-east");
    expect(radio("Europlots").disabled).toBe(false);
  });

  it("keeps the provider's order for equal quotes, and sorts each group by price", () => {
    render(
      ui(
        pending({
          offers: [
            offer("z", 0.04, { name: "Zed" }),
            offer("y", 0.04, { name: "Yew" }),
            offer("x", 0.09, { name: "Dear" }, "not audited"),
            offer("w", 0.01, { name: "Cheap" }, "not audited"),
          ],
        })
      )
    );
    expect(radioNames()).toEqual(["Zed", "Yew", "Cheap", "Dear"]);
  });

  it("lists every offer even when none can be chosen, so the list explains itself", () => {
    render(
      ui(
        pending({
          offersReadAt: T0 + 6000,
          offers: [
            offer("a", 0.03, { name: "First" }, "not on your trusted list"),
            offer("b", 0.04, { name: "Second" }, "not audited"),
          ],
        })
      )
    );
    expect(radio("First").disabled).toBe(true);
    expect(describedBy(radio("First"))).toBe("Not on your trusted list");
    expect(describedBy(radio("Second"))).toBe("Not audited");
    expect(unavailable("Lease offer")).toBe(true);
    advance(31_000);
    expect(radios()).toHaveLength(2);
    expect(noneText()).toBeNull();
    expect(button("Retry")).toBeNull();
  });

  it("shows what last went wrong, and a refusal of its own ahead of it", async () => {
    client.cancelOrder.mockRejectedValue(
      new ClientAppError("OUTCOME_UNKNOWN", "lost", "Akash didn't confirm the close yet.")
    );
    render(ui(pending({ offers: [offer("a", 0.03)] }), "The last order was closed."));
    expect(screen.getByText("The last order was closed.")).toBeTruthy();
    fireEvent.click(button("Cancel order")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Akash didn't confirm the close yet.");
    expect(screen.queryByText("The last order was closed.")).toBeNull();
  });
});

describe("CloudOfferChoice leasing and cancelling", () => {
  const two = (a = 0.036, b = 0.05, aReason: string | null = null) =>
    pending({
      offersReadAt: T0 + 8000,
      offers: [offer("a", a, { name: "Europlots" }, aReason), offer("b", b, { name: "Hurricane" })],
    });

  it("leases the offer picked, of the order shown, at the quote shown", async () => {
    client.chooseOffer.mockResolvedValue(undefined);
    render(ui(two()));
    expect(unavailable("Lease offer")).toBe(true);
    fireEvent.click(radio("Hurricane"));
    fireEvent.click(button("Lease offer")!);
    await settle();
    expect(client.chooseOffer).toHaveBeenCalledTimes(1);
    expect(client.chooseOffer).toHaveBeenCalledWith("build", "dseq-1", "b", 0.05);
  });

  it("sends one lease and nothing else while it's out", async () => {
    const answer = deferred();
    client.chooseOffer.mockReturnValue(answer.promise);
    render(ui(two()));
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Lease offer")!);
    expect(button("Lease offer")!.getAttribute("aria-busy")).toBe("true");
    expect(button("Cancel order")!.disabled).toBe(true);
    expect(radio("Hurricane").disabled).toBe(true);
    fireEvent.click(button("Lease offer")!);
    fireEvent.click(button("Cancel order")!);
    await act(async () => answer.resolve());
    expect(client.chooseOffer).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("keeps a pick across a reorder", () => {
    const view = render(ui(two()));
    fireEvent.click(radio("Europlots"));
    // Hurricane undercuts it, so Europlots moves down a row.
    view.rerender(ui(two(0.036, 0.01)));
    expect(radioNames()).toEqual(["Hurricane", "Europlots"]);
    expect(radio("Europlots").checked).toBe(true);
    expect(unavailable("Lease offer")).toBe(false);
  });

  it.each([
    ["requoted", two(0.04)],
    ["withdrawn", pending({ offers: [offer("b", 0.05, { name: "Hurricane" })] })],
    ["no longer choosable", two(0.036, 0.05, "not on your trusted list")],
  ])("drops a pick whose offer is %s, and never brings it back", (_how, moved) => {
    const view = render(ui(two()));
    fireEvent.click(radio("Europlots"));
    view.rerender(ui(moved));
    expect(radios().some((input) => input.checked)).toBe(false);
    expect(unavailable("Lease offer")).toBe(true);
    expect(screen.getByTestId("cloud-offer-choice-lost").textContent).toContain("Pick one again");
    view.rerender(ui(two()));
    expect(radio("Europlots").checked).toBe(false);
    expect(unavailable("Lease offer")).toBe(true);
  });

  it("says why a lease was refused, and clears that with the next lease", async () => {
    client.chooseOffer.mockRejectedValueOnce(
      new ClientAppError("NOT_FOUND", "gone", "That offer was withdrawn. Choose another.")
    );
    render(ui(two()));
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Lease offer")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("That offer was withdrawn. Choose another.");
    expect(radio("Europlots").checked).toBe(false);
    expect(unavailable("Lease offer")).toBe(true);
    expect(button("Cancel order")!.disabled).toBe(false);

    const second = deferred();
    client.chooseOffer.mockReturnValueOnce(second.promise);
    fireEvent.click(radio("Hurricane"));
    fireEvent.click(button("Lease offer")!);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.chooseOffer).toHaveBeenLastCalledWith("build", "dseq-1", "b", 0.05);
    await act(async () => second.resolve());
  });

  it("holds every action once a lease went through, until a later snapshot arrives", async () => {
    client.chooseOffer.mockResolvedValue(undefined);
    const shown = two();
    const view = render(ui(shown));
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Lease offer")!);
    await settle();
    view.rerender(ui(shown));
    expect(unavailable("Lease offer")).toBe(true);
    expect(button("Cancel order")!.disabled).toBe(true);
    expect(radio("Hurricane").disabled).toBe(true);

    view.rerender(ui(two()));
    expect(unavailable("Lease offer")).toBe(false);
    expect(button("Cancel order")!.disabled).toBe(false);
    expect(radio("Hurricane").disabled).toBe(false);
    expect(radio("Europlots").checked).toBe(true);
  });

  it("holds against the snapshot in view when the lease answered, not the one it left from", async () => {
    const answer = deferred();
    client.chooseOffer.mockReturnValue(answer.promise);
    const view = render(ui(two()));
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Lease offer")!);
    // An ordinary refresh lands while the lease is out.
    const refreshed = two();
    view.rerender(ui(refreshed));
    await act(async () => answer.resolve());
    expect(button("Cancel order")!.disabled).toBe(true);
    view.rerender(ui(two()));
    expect(button("Cancel order")!.disabled).toBe(false);
  });

  it("cancels the order shown, holding every action until a later snapshot arrives", async () => {
    const answer = deferred();
    client.cancelOrder.mockReturnValue(answer.promise);
    const shown = two();
    const view = render(ui(shown));
    fireEvent.click(radio("Europlots"));
    fireEvent.click(button("Cancel order")!);
    expect(unavailable("Lease offer")).toBe(true);
    expect(button("Cancel order")!.getAttribute("aria-busy")).toBe("true");
    await act(async () => answer.resolve());
    expect(client.cancelOrder).toHaveBeenCalledWith("build", "dseq-1");
    view.rerender(ui(shown));
    expect(unavailable("Lease offer")).toBe(true);
    expect(button("Cancel order")!.disabled).toBe(true);
    view.rerender(ui(two()));
    expect(unavailable("Lease offer")).toBe(false);
    expect(button("Cancel order")!.disabled).toBe(false);
  });

  it("says why a cancel was refused, and offers it again", async () => {
    client.cancelOrder.mockRejectedValueOnce(
      new ClientAppError("OUTCOME_UNKNOWN", "lost", "Akash didn't confirm the close yet.")
    );
    render(ui(pending()));
    fireEvent.click(button("Cancel order")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Akash didn't confirm the close yet.");
    expect(button("Cancel order")!.disabled).toBe(false);
  });
});
