// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HostListEntry, HostMetricsSummary } from "@shared/types/remoteHosts";

vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: {
    update: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    listClipboardGrants: vi.fn(async () => []),
    resetClipboardGrants: vi.fn(async () => undefined),
    pluginParity: vi.fn(async () => []),
  },
}));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));

import { HostDetail } from "../HostDetail";

const HANDSHAKE = {
  version: "0.38.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux" as const,
  arch: "x64" as const,
};

function entry(forges: HostMetricsSummary["forges"], connected = true): HostListEntry {
  return {
    descriptor: {
      id: "studio-01",
      name: "studio-01",
      sshTarget: "greg@studio",
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
    },
    connection: connected
      ? { status: "connected", rttMs: 3, handshake: HANDSHAKE }
      : { status: "disconnected" },
    summary: connected
      ? ({
          hostId: "studio-01",
          sampledAt: 1,
          platform: "linux",
          agentClis: [],
          ...(forges !== undefined ? { forges } : {}),
        } as unknown as HostMetricsSummary)
      : null,
  } as HostListEntry;
}

function accounts(): string {
  const heading = screen.getByText("Accounts");
  return heading.closest("section")?.textContent ?? document.body.textContent ?? "";
}

describe("HostDetail forge connections", () => {
  it("lists each forge the host reports, in words naming the host", () => {
    render(
      <HostDetail
        entry={entry([
          {
            providerId: "daintree.github.github",
            name: "GitHub",
            hasCredential: true,
            account: "greg",
          },
          {
            providerId: "daintree.gitlab.gitlab",
            name: "GitLab",
            hasCredential: false,
            account: null,
          },
          { providerId: "acme.gitea.gitea", name: "Gitea", hasCredential: true, account: null },
        ])}
        onBack={() => {}}
      />
    );
    const text = accounts();
    expect(text).toContain("Signed in as greg on studio-01");
    expect(text).toContain("GitLab isn't connected on studio-01");
    expect(text).toContain("A credential is saved on studio-01, and it hasn't reported an account");
    expect(text).not.toContain("Not reported by this host yet");
  });

  it("says what is missing when the host hasn't reported, or isn't connected", () => {
    const { unmount } = render(<HostDetail entry={entry(undefined)} onBack={() => {}} />);
    expect(accounts()).toContain("studio-01 hasn't reported its forge connections");
    unmount();
    render(<HostDetail entry={entry(undefined, false)} onBack={() => {}} />);
    expect(accounts()).toContain("Connect to studio-01 to see its forge connections");
  });

  it("says when the host has no forge providers", () => {
    render(<HostDetail entry={entry([])} onBack={() => {}} />);
    expect(accounts()).toContain("No forge providers are enabled on studio-01");
  });
});
