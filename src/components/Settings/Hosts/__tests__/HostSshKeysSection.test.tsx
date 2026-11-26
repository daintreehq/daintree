// @vitest-environment jsdom
import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostSshHostKeys,
  HostSshKey,
  HostSshListenerBaseline,
  HostSshListenerReading,
} from "@shared/types/ipc/remoteHosts";
import { TooltipProvider } from "@/components/ui/tooltip";

const client = vi.hoisted(() => ({ readSshHostKeys: vi.fn() }));

vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: { readSshHostKeys: client.readSshHostKeys },
}));

import { HostSshKeysSection } from "../HostSshKeysSection";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

function key(char: string, type = "ssh-ed25519"): HostSshKey {
  return { type, fingerprint: `SHA256:${char.repeat(43)}`, publicKey: `${type} AAAAC3${char}` };
}

function listener(
  keys: HostSshKey[],
  overrides: Partial<HostSshListenerReading> = {}
): HostSshListenerReading {
  return {
    listenerId: "main",
    configFile: null,
    listenAddresses: ["0.0.0.0:22"],
    complete: true,
    gaps: [],
    keys,
    keyGaps: [],
    ...overrides,
  };
}

function baseline(
  keys: HostSshKey[],
  change: HostSshListenerBaseline["change"] = null
): HostSshListenerBaseline {
  return {
    listenerId: "main",
    configFile: null,
    listenAddresses: ["0.0.0.0:22"],
    keys,
    readAt: Date.now() - 60_000,
    change,
  };
}

async function show(answer: HostSshHostKeys, props: { connected?: boolean } = {}) {
  client.readSshHostKeys.mockResolvedValue(answer);
  await act(async () => {
    render(
      <HostSshKeysSection
        hostId="box"
        hostName="box"
        connected={props.connected ?? true}
        connectionKey="ssh:box"
        trust="Your own SSH configuration decides"
        pinnedFingerprint={null}
      />
    );
  });
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client.readSshHostKeys.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

describe("HostSshKeysSection", () => {
  it("shows each key's fingerprint and copies it and the public key", async () => {
    const ed = key("A");
    const rsa = key("B", "ssh-rsa");
    await show({
      outcome: {
        status: "reading",
        complete: true,
        truncated: false,
        listeners: [listener([ed, rsa])],
      },
      baselines: [baseline([ed, rsa])],
    });
    expect(client.readSshHostKeys).toHaveBeenCalledWith("box");
    expect(screen.getByText(ed.fingerprint)).toBeTruthy();
    expect(screen.getByText(rsa.fingerprint)).toBeTruthy();
    expect(screen.queryByTestId("ssh-key-change")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy ssh-rsa fingerprint" }));
    });
    expect(writeText).toHaveBeenLastCalledWith(rsa.fingerprint);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy ssh-ed25519 public key" }));
    });
    expect(writeText).toHaveBeenLastCalledWith(ed.publicKey);
  });

  it("shows a change with the old and new fingerprints", async () => {
    const before = key("A");
    const now = key("C");
    await show({
      outcome: {
        status: "reading",
        complete: true,
        truncated: false,
        listeners: [listener([now])],
      },
      baselines: [baseline([now], { previous: [before], changedAt: Date.now() - 1000 })],
    });
    const change = screen.getByTestId("ssh-key-change");
    expect(within(change).getByText(new RegExp(before.fingerprint))).toBeTruthy();
    expect(within(change).getByText(new RegExp(now.fingerprint))).toBeTruthy();
  });

  it("keeps the last complete reading as the baseline when a read is partial", async () => {
    const kept = key("A");
    const partial = key("B");
    await show({
      outcome: {
        status: "reading",
        complete: false,
        truncated: false,
        listeners: [
          listener([partial], {
            complete: false,
            gaps: ["timed-out"],
            keyGaps: [
              { publicKeyPath: "/etc/ssh/ssh_host_rsa_key.pub", reason: "permission-denied" },
            ],
          }),
        ],
      },
      baselines: [baseline([kept])],
    });
    expect(screen.getByText("Partial reading")).toBeTruthy();
    expect(screen.getByText(/stays what the next one is compared with/)).toBeTruthy();
    // The kept fingerprint is still shown as the baseline, and nothing reads as a change.
    expect(screen.getByText(new RegExp(kept.fingerprint))).toBeTruthy();
    expect(screen.getByText(partial.fingerprint)).toBeTruthy();
    expect(screen.getByText("Not readable by Daintree's user")).toBeTruthy();
    expect(screen.queryByTestId("ssh-key-change")).toBeNull();
  });

  it("says so when no SSH server is visible on the host", async () => {
    await show({ outcome: { status: "no-sshd-visible" }, baselines: [] });
    expect(screen.getByTestId("ssh-keys-status").textContent).toBe(
      "No SSH server is visible to Daintree's user on box"
    );
  });

  it("shows what this computer kept while the host isn't connected, and reads again on Refresh", async () => {
    const kept = key("A");
    await show(
      { outcome: { status: "not-connected" }, baselines: [baseline([kept])] },
      {
        connected: false,
      }
    );
    expect(screen.getByText("Last complete reading")).toBeTruthy();
    expect(screen.getByText(kept.fingerprint)).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
  });

  it("reads again on Refresh", async () => {
    await show({ outcome: { status: "timed-out" }, baselines: [] });
    client.readSshHostKeys.mockResolvedValue({
      outcome: {
        status: "reading",
        complete: true,
        truncated: false,
        listeners: [listener([key("D")])],
      },
      baselines: [baseline([key("D")])],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(client.readSshHostKeys).toHaveBeenCalledTimes(2);
    expect(screen.getByText(key("D").fingerprint)).toBeTruthy();
    expect(screen.queryByTestId("ssh-keys-status")).toBeNull();
  });
});
