import { afterEach, describe, expect, it } from "vitest";
import { LinkClient, type LinkClientState } from "../LinkClient.js";
import { TransportError, type LinkTransport } from "../transport.js";
import { TEST_HANDSHAKE, waitFor } from "../../link/__tests__/linkTestUtils.js";

let client: LinkClient | null = null;

afterEach(async () => {
  await client?.stop();
  client = null;
});

function failingTransport(detail: string): LinkTransport & { opens: number } {
  const t = {
    opens: 0,
    async open() {
      t.opens++;
      throw new TransportError("unreachable", detail);
    },
  };
  return t;
}

describe("LinkClient backoff", () => {
  it("retries with capped exponential backoff and reports what it saw", async () => {
    const transport = failingTransport("Connection timed out");
    const now = 1_000;
    const states: LinkClientState[] = [];
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 5, maxMs: 20, jitter: 0.5 },
      random: () => 0,
      now: () => now,
    });
    client.onStateChange((s) => states.push(s));
    client.start();
    await waitFor(() => transport.opens >= 5);
    const delays = states
      .filter(
        (s): s is Extract<LinkClientState, { status: "unreachable" }> => s.status === "unreachable"
      )
      .map((s) => s.retryAt - now);
    expect(delays.slice(0, 4)).toEqual([5, 10, 20, 20]);
    expect(states[0]).toEqual({ status: "connecting", attempt: 1 });
    expect(states[1]).toMatchObject({ status: "unreachable", detail: "Connection timed out" });
  });

  it("applies jitter below the base delay", async () => {
    const transport = failingTransport("x");
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 1_000, jitter: 0.5 },
      random: () => 1,
      now: () => 0,
    });
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({ retryAt: 500 });
  });

  it("stops retrying and returns to disconnected on stop", async () => {
    const transport = failingTransport("x");
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 5 },
    });
    client.start();
    await waitFor(() => transport.opens >= 2);
    await client.stop();
    const opens = transport.opens;
    await new Promise((r) => setTimeout(r, 40));
    expect(transport.opens).toBe(opens);
    expect(client.getState()).toEqual({ status: "disconnected" });
  });
});
