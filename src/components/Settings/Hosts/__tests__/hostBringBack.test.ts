import { describe, expect, it } from "vitest";
import type { HostBringBackAnswer } from "@shared/types/hostWake";
import type { HostDescriptor } from "@shared/types/remoteHosts";
import { canBringBack, describeBringBack, wakeLabel } from "../hostBringBack";

function answer(overrides: Partial<HostBringBackAnswer>): HostBringBackAnswer {
  return {
    status: "timed_out",
    wake: "not_set_up",
    reached: false,
    startRequested: false,
    observed: null,
    elapsedMs: 120_400,
    ...overrides,
  };
}

const studio = (overrides: Partial<HostDescriptor> = {}): HostDescriptor => ({
  id: "studio",
  name: "Studio",
  connection: { kind: "ssh", target: "studio.local" },
  platform: "darwin",
  arch: "arm64",
  lastHandshake: null,
  lastSeenAt: null,
  addedAt: 0,
  notificationsEnabled: false,
  assistantControlEnabled: true,
  ...overrides,
});

describe("describeBringBack (#16170)", () => {
  it("leaves a host that came back to its status", () => {
    for (const status of ["connected", "woken", "started"] as const) {
      expect(describeBringBack(answer({ status }), "Studio", null)).toBeNull();
    }
  });

  it("says which way a wake couldn't happen", () => {
    expect(
      describeBringBack(answer({ status: "not_wakeable", wake: "not_on_lan" }), "Studio", "10.0.0.0/24")
    ).toBe("Studio didn't answer over SSH, and this machine isn't on its LAN (10.0.0.0/24) to wake it");
    expect(
      describeBringBack(
        answer({ status: "not_wakeable", wake: "failed", observed: "EADDRNOTAVAIL" }),
        "Studio",
        null
      )
    ).toBe("Studio didn't answer over SSH, and its wake couldn't be sent: EADDRNOTAVAIL");
  });

  it("names what it did before giving up", () => {
    expect(describeBringBack(answer({ wake: "sent", startRequested: true }), "Studio", null)).toBe(
      "Studio wasn't back within 120 s after a wake and a start, and may still connect"
    );
    expect(describeBringBack(answer({}), "Studio", null)).toBe(
      "Studio wasn't back within 120 s, and may still connect"
    );
  });
});

describe("the host row's wake and Bring back", () => {
  it("offers Bring back only while the link is neither up nor coming up", () => {
    expect(canBringBack({ status: "unreachable", lastSeenAt: null, detail: null })).toBe(true);
    expect(canBringBack({ status: "disconnected" })).toBe(true);
    expect(canBringBack({ status: "connecting", attempt: 1 })).toBe(false);
  });

  it("says whether an SSH host can be woken, and nothing for a WSL distro", () => {
    expect(wakeLabel(studio())).toBe("No wake set up");
    expect(wakeLabel(studio({ wake: { mac: "aa:bb:cc:dd:ee:f0", lan: "192.168.1.0/24" } }))).toBe(
      "Wakes over 192.168.1.0/24"
    );
    expect(wakeLabel(studio({ connection: { kind: "wsl", distro: "Ubuntu" } }))).toBeNull();
  });
});
