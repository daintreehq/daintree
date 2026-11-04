import { describe, expect, it } from "vitest";
import {
  BRIDGE_FEATURES,
  MemoryKeyStore,
  RelayClient,
  bridgeFeatures,
  loadIdentity,
  type Identity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url, type ProtocolFeature } from "@daintreehq/decisions-protocol";
import { DaintreeRelayClient } from "../relayFeatures.js";

async function identity(): Promise<Identity> {
  const keys = new MemoryKeyStore();
  await keys.save({
    v: 1,
    config: {
      relayOrigin: "https://decisions.example.workers.dev",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  });
  return loadIdentity(keys);
}

/** What each request asked for, answered as the relay would. */
async function clients() {
  const sent: Array<{ url: URL; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push({
      url,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    });
    const body = url.pathname.endsWith("/socket-ticket")
      ? { ticket: "t", expires_at: new Date(Date.now() + 30_000).toISOString(), ws_path: "/ws" }
      : {
          protocol_version: 1,
          from_exclusive: 0,
          high_water_seq: 0,
          events: [],
          next_after: 0,
          has_more: false,
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const options = { identity: await identity(), fetch, maxRetries: 0 };
  return { sent, stock: new RelayClient(options), daintree: new DaintreeRelayClient(options) };
}

describe("DaintreeRelayClient (#16229)", () => {
  // Every feature a 0.4.0 bridge can ask to declare, follow-ups and snapshots included.
  const asked: readonly ProtocolFeature[] = bridgeFeatures({
    followUps: true,
    snapshots: { onRefresh: () => {} },
  });

  // Daintree declares none until it handles each one; a feature joins with its own work, and changes this test.
  it("declares no feature on event pages or socket tickets, whatever the bridge asks", async () => {
    const { sent, stock, daintree } = await clients();
    expect(BRIDGE_FEATURES.length).toBeGreaterThan(0);

    await stock.events(5, 10, asked);
    await stock.socketTicket(asked);
    expect(sent[0]!.url.searchParams.get("features")).not.toBeNull();
    expect(sent[1]!.body).toHaveProperty("features");

    await daintree.events(5, 10, asked);
    await daintree.socketTicket(asked);
    const [page, ticket] = sent.slice(2);
    expect(page!.url.searchParams.has("features")).toBe(false);
    expect(page!.url.searchParams.get("after")).toBe("5");
    expect(page!.url.searchParams.get("limit")).toBe("10");
    expect(ticket!.body).not.toHaveProperty("features");
  });

  it("keeps the library's defaults when the caller declares nothing", async () => {
    const { sent, daintree } = await clients();

    await daintree.events(0);
    await daintree.socketTicket();

    expect(sent[0]!.url.searchParams.get("limit")).toBe("100");
    expect(sent[0]!.url.searchParams.has("features")).toBe(false);
    expect(sent[1]!.body).not.toHaveProperty("features");
  });
});
