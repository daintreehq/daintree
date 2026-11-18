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
  // Every feature a 0.8.0 bridge can ask to declare, follow-ups and snapshots included.
  const asked: readonly ProtocolFeature[] = bridgeFeatures({
    followUps: true,
    snapshots: { onRefresh: () => {} },
  });

  // Daintree declares a feature only once it handles it; each joins with its own work, and changes this test.
  it("declares follow-ups, pane snapshots, phone images, involvement hints, owner-desktop answers and follow-ups, person declines and owner-desktop declines on event pages and socket tickets (#16231, #16230, #16233, #17228, #17101, #17238, #17234, #17239)", async () => {
    const { sent, stock, daintree } = await clients();
    expect(BRIDGE_FEATURES).toContain("phone-images-v1");
    expect(BRIDGE_FEATURES).toContain("involvement-v1");
    expect(BRIDGE_FEATURES).toContain("owner-desktop-answers-v1");
    expect(BRIDGE_FEATURES).toContain("person-declines-v1");
    expect(BRIDGE_FEATURES).toContain("owner-desktop-declines-v1");
    expect(asked).toContain("owner-desktop-messages-v1");
    expect(asked).toContain("pane-snapshots-v1");

    await stock.events(5, 10, asked);
    await stock.socketTicket(asked);
    expect((sent[1]!.body as { features: string[] }).features.length).toBe(asked.length);

    await daintree.events(5, 10, asked);
    await daintree.socketTicket(asked);
    const [page, ticket] = sent.slice(2);
    expect(page!.url.searchParams.get("features")).toBe(
      "involvement-v1,owner-desktop-answers-v1,owner-desktop-declines-v1,owner-desktop-messages-v1,pane-snapshots-v1,person-declines-v1,phone-images-v1,thread-messages-v1"
    );
    expect(page!.url.searchParams.get("after")).toBe("5");
    expect(page!.url.searchParams.get("limit")).toBe("10");
    expect(ticket!.body).toHaveProperty("features", [
      "involvement-v1",
      "owner-desktop-answers-v1",
      "owner-desktop-declines-v1",
      "owner-desktop-messages-v1",
      "pane-snapshots-v1",
      "person-declines-v1",
      "phone-images-v1",
      "thread-messages-v1",
    ]);
  });

  it("declares every feature the 0.8.0 release's bridge asks for, so a phone and this computer can decline its questions and this computer can follow up on them (#17234, #17238, #17239)", async () => {
    const { sent, daintree } = await clients();
    const lastJoined: readonly ProtocolFeature[] = [
      "owner-desktop-messages-v1",
      "person-declines-v1",
      "owner-desktop-declines-v1",
    ];
    for (const feature of lastJoined) expect(asked).toContain(feature);

    await daintree.events(5, 10, asked);
    await daintree.socketTicket(asked);

    const declared = [
      sent[0]!.url.searchParams.get("features")!.split(","),
      (sent[1]!.body as { features: string[] }).features,
    ];
    for (const features of declared) expect([...features].sort()).toEqual([...asked].sort());
  });

  it("declares nothing for a feature a later bridge asks for that Daintree doesn't handle", async () => {
    const { sent, daintree } = await clients();
    // Presence is the relay's to advertise, never a desktop's (#17240); the voice note is one no release has.
    const later: ProtocolFeature[] = ["presence-v1", "voice-notes-v1" as ProtocolFeature];

    await daintree.events(5, 10, later);
    await daintree.socketTicket(later);

    expect(sent[0]!.url.searchParams.has("features")).toBe(false);
    expect(sent[1]!.body).not.toHaveProperty("features");
  });

  it("declares no snapshots for a bridge that publishes none", async () => {
    const { sent, daintree } = await clients();

    await daintree.socketTicket(bridgeFeatures({ followUps: true }));

    expect(sent[0]!.body).toHaveProperty("features", [
      "involvement-v1",
      "owner-desktop-answers-v1",
      "owner-desktop-declines-v1",
      "owner-desktop-messages-v1",
      "person-declines-v1",
      "phone-images-v1",
      "thread-messages-v1",
    ]);
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
