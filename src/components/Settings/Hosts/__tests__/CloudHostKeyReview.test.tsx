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
    hosts: [
      {
        hostId: "droplet",
        providerId: "digitalocean",
        providerUnavailable: null,
        accountId: "ca_0123456789",
        accountName: "Web team",
        resourceId: "3164444",
        machineName: "droplet",
        ownership: "created-by-daintree",
        createdFor: null,
        worktreeCleanup: null,
        provisioning: null,
        machine: "running",
        rawState: "active",
        machineType: "s-2vcpu-4gb",
        vcpu: 2,
        memoryGB: 4,
        hourlyDollars: 0.036,
        lifetime: { kind: "none" },
        autoStopAt: null,
        lifetimeSeconds: null,
        stoppedAt: null,
        stop: null,
        lastSnapshotAt: null,
        dataExpired: false,
        operation: null,
        lastError: null,
        observedAt: 0,
        lastEndpoint: null,
        hostKeyFingerprint: null,
        hostKeyReview,
        keptRunningAt: null,
        asleep: false,
      },
    ],
  };
}

beforeEach(() => {
  client.trustHostKey.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CloudSetupHostKey", () => {
  it("shows its note instead while no key is waiting", () => {
    withStatus(null);
    const { container } = render(
      <CloudSetupHostKey hostId="droplet" onTrusted={() => {}} note={<p>Still setting up</p>} />
    );
    expect(container.textContent).toBe("Still setting up");
    expect(screen.queryByRole("button", { name: "Trust this key" })).toBeNull();
  });

  it("names the host key file of the kind the machine presented, to check it by", () => {
    withStatus({ ...REVIEW, keyType: "ECDSA" });
    render(
      <CloudSetupHostKey hostId="droplet" onTrusted={() => {}} note={<p>Still setting up</p>} />
    );
    const shown = screen.getByTestId("cloud-host-key-review").textContent ?? "";
    expect(shown).toContain("ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub");
    // The key, not the note, is what setup is stopped on.
    expect(shown).not.toContain("Still setting up");
    expect(document.body.textContent).not.toContain("Still setting up");
  });

  it("warns about a changed key and trusts the new one by its own fingerprint", async () => {
    const changed = {
      ...REVIEW,
      reason: "changed" as const,
      fingerprint: "SHA256:newnewnewnewnewnewnewnewnewnewnewnewnewnew",
      previousFingerprint: REVIEW.fingerprint,
      previousTrustedAt: 0,
    };
    withStatus(changed);
    client.trustHostKey.mockResolvedValue(undefined);
    const onTrusted = vi.fn();
    render(<CloudSetupHostKey hostId="droplet" onTrusted={onTrusted} />);
    expect(screen.getByTestId("cloud-host-key-review").textContent).toContain("identity changed");
    fireEvent.click(screen.getByRole("button", { name: "Trust new key" }));
    await waitFor(() => expect(onTrusted).toHaveBeenCalledTimes(1));
    expect(client.trustHostKey).toHaveBeenCalledWith("droplet", changed.fingerprint);
  });

  it("trusts the key by the fingerprint it showed, then lets setup look again", async () => {
    withStatus(REVIEW);
    client.trustHostKey.mockResolvedValue(undefined);
    const onTrusted = vi.fn();
    render(<CloudSetupHostKey hostId="droplet" onTrusted={onTrusted} />);
    expect(screen.getByTestId("cloud-host-key-review").textContent).toContain(REVIEW.fingerprint);
    expect(screen.getByTestId("cloud-host-key-review").textContent).toContain(
      "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub prints in DigitalOcean's console"
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
