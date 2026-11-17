// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CloudHostsSnapshot, CloudHostStatus } from "@shared/types/cloudHosts";
import { BOAT_PROVIDER } from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

const { cloud, client } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
  client: { trustHostKey: vi.fn() },
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: client }));

import { CloudSetupHostKey } from "../CloudHostKeyReview";

const REVIEW = {
  reason: "first-connect" as const,
  fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  keyType: "ED25519",
  seenAt: 0,
  previousFingerprint: null,
  previousTrustedAt: null,
};

function withStatus(hostKeyReview: CloudHostStatus["hostKeyReview"]) {
  cloud.snapshot = {
    providers: [{ ...BOAT_PROVIDER, id: "digitalocean", name: "DigitalOcean" }],
    accounts: [],
    hosts: [{ hostId: "droplet", providerId: "digitalocean", hostKeyReview } as CloudHostStatus],
  };
}

beforeEach(() => {
  client.trustHostKey.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CloudSetupHostKey", () => {
  it("shows nothing while no key is waiting", () => {
    withStatus(null);
    const { container } = render(<CloudSetupHostKey hostId="droplet" onTrusted={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("trusts the key by the fingerprint it showed, then lets setup look again", async () => {
    withStatus(REVIEW);
    client.trustHostKey.mockResolvedValue(undefined);
    const onTrusted = vi.fn();
    render(<CloudSetupHostKey hostId="droplet" onTrusted={onTrusted} />);
    expect(screen.getByTestId("cloud-host-key-review").textContent).toContain(REVIEW.fingerprint);
    expect(screen.getByTestId("cloud-host-key-review").textContent).toContain(
      "DigitalOcean's console"
    );
    fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
    await waitFor(() => expect(onTrusted).toHaveBeenCalledTimes(1));
    expect(client.trustHostKey).toHaveBeenCalledWith("droplet", REVIEW.fingerprint);
  });

  it("says why a trust was refused, and doesn't move setup on", async () => {
    withStatus(REVIEW);
    client.trustHostKey.mockRejectedValue(new Error("The key changed again"));
    const onTrusted = vi.fn();
    render(<CloudSetupHostKey hostId="droplet" onTrusted={onTrusted} />);
    fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The key changed again");
    expect(onTrusted).not.toHaveBeenCalled();
  });
});
