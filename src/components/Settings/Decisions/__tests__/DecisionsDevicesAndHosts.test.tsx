// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  DecisionsDevice,
  DecisionsDevicesResult,
  DecisionsRevokeDeviceResult,
  DecisionsRotateKeysResult,
  DecisionsStatus,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DecisionsHost, DecisionsHostsResult } from "@shared/types/decisionsHosts";
import { DecisionsDevicesAndHosts } from "../DecisionsDevicesAndHosts";

const ORIGIN = "https://decisions.example.workers.dev";
const STATUS: DecisionsStatus = { state: "connected", relayOrigin: ORIGIN };

const PIXEL: DecisionsDevice = {
  deviceId: "dev_pixel",
  label: "Pixel 9",
  role: "phone",
  pairedAt: "2026-10-30T00:00:00.000Z",
  lastSeenAt: null,
  pushEnabled: true,
};
const IPAD: DecisionsDevice = { ...PIXEL, deviceId: "dev_ipad", label: "iPad", role: "tablet" };
const STUDIO_DEVICE: DecisionsDevice = {
  ...PIXEL,
  deviceId: "dev_studio",
  label: "studio.local",
  role: "desktop-host",
  pushEnabled: false,
};
const STUDIO: DecisionsHost = {
  hostId: "studio",
  name: "studio",
  connected: true,
  enrollment: { state: "enrolled", deviceId: "dev_studio" },
  canEnroll: false,
};

const listDevices = vi.fn<() => Promise<DecisionsDevicesResult>>();
const revokeDevice = vi.fn<(deviceId: string) => Promise<DecisionsRevokeDeviceResult>>();
const rotateKeys = vi.fn<() => Promise<DecisionsRotateKeysResult>>();
const listHosts = vi.fn<() => Promise<DecisionsHostsResult>>();
const pushes = new Set<() => void>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function renderSection() {
  render(
    <TooltipProvider>
      <DecisionsDevicesAndHosts status={STATUS} />
    </TooltipProvider>
  );
  await screen.findByText("Pixel 9");
}

function revokeButton(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: `Revoke ${label}` }) as HTMLButtonElement;
}

function dialog(): HTMLElement {
  return screen.getByRole("alertdialog");
}

describe("DecisionsDevicesAndHosts revoke and rotate (#16010)", () => {
  beforeEach(() => {
    pushes.clear();
    listDevices.mockReset().mockResolvedValue({ result: "listed", devices: [PIXEL, IPAD] });
    revokeDevice.mockReset();
    rotateKeys.mockReset();
    listHosts.mockReset().mockResolvedValue({ result: "listed", autoEnroll: true, hosts: [] });
    Object.defineProperty(window, "electron", {
      value: {
        decisions: {
          listDevices,
          revokeDevice,
          rotateKeys,
          // The Remote Hosts section reads its own rows (#16021).
          listHosts,
        },
        events: {
          on: (name: string, listener: () => void) => {
            if (name !== "decisions:devices-changed") return () => {};
            pushes.add(listener);
            return () => pushes.delete(listener);
          },
        },
      },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("confirms naming the device and saying what it holds can't be recalled, and Cancel sends nothing", async () => {
    await renderSection();

    fireEvent.click(revokeButton("Pixel 9"));

    const confirm = dialog();
    expect(within(confirm).getByText("Revoke 'Pixel 9'?")).toBeTruthy();
    expect(confirm.textContent).toContain("already on 'Pixel 9' can't be recalled");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it("revokes only the confirmed device, then reads the list again and says the key changed", async () => {
    revokeDevice.mockResolvedValue({ result: "revoked", keyEpoch: 2 });
    await renderSection();
    // The list reads again only after the dialog has closed, so its row is still there then.
    const reread = deferred<DecisionsDevicesResult>();
    listDevices.mockReturnValue(reread.promise);

    const opener = revokeButton("Pixel 9");
    opener.focus();
    fireEvent.click(opener);
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Revoke device" }));
    });

    expect(revokeDevice).toHaveBeenCalledExactlyOnceWith("dev_pixel");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // Focus goes to the key row, not back to the row that is about to go.
    const rotate = screen.getByRole("button", { name: "Rotate keys" });
    await waitFor(() => expect(document.activeElement).toBe(rotate));
    await act(async () => {
      reread.resolve({ result: "listed", devices: [IPAD] });
    });
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/'Pixel 9' is revoked/)).toBeTruthy();
    expect(screen.queryByText("Pixel 9")).toBeNull();
    expect(document.activeElement).toBe(rotate);
  });

  it("keeps the dialog open with what was observed when the relay's answer was lost", async () => {
    revokeDevice.mockResolvedValue({ result: "unconfirmed", origin: ORIGIN });
    await renderSection();

    fireEvent.click(revokeButton("Pixel 9"));
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Revoke device" }));
    });

    const alert = within(dialog()).getByRole("alert");
    expect(alert.textContent).toContain("decisions.example.workers.dev");
    expect(alert.textContent).toContain("sends it again");
  });

  it("rotates without revoking anyone, one request at a time, and says what it came to", async () => {
    const rotation = deferred<DecisionsRotateKeysResult>();
    rotateKeys.mockReturnValue(rotation.promise);
    await renderSection();

    const rotate = screen.getByRole("button", { name: "Rotate keys" }) as HTMLButtonElement;
    rotate.focus();
    fireEvent.click(rotate);
    fireEvent.click(rotate);
    // Busy, not disabled, so the button keeps focus; nothing else changes the key meanwhile.
    expect(rotate.getAttribute("aria-busy")).toBe("true");
    expect(rotate.disabled).toBe(false);
    expect(document.activeElement).toBe(rotate);
    expect(revokeButton("Pixel 9").disabled).toBe(true);
    await act(async () => {
      rotation.resolve({ result: "rotated", keyEpoch: 3 });
    });

    expect(rotateKeys).toHaveBeenCalledOnce();
    expect(revokeDevice).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("The relay holds a new key");
    expect(revokeButton("Pixel 9").disabled).toBe(false);
  });

  it("offers a rotation with no device paired", async () => {
    listDevices.mockResolvedValue({ result: "listed", devices: [] });
    render(
      <TooltipProvider>
        <DecisionsDevicesAndHosts status={STATUS} />
      </TooltipProvider>
    );

    rotateKeys.mockResolvedValue({ result: "rotated", keyEpoch: 2 });
    const rotate = await screen.findByRole("button", { name: "Rotate keys" });
    await act(async () => {
      fireEvent.click(rotate);
    });

    expect(rotateKeys).toHaveBeenCalledOnce();
  });

  it("reads the list again when main says the devices changed", async () => {
    await renderSection();
    listDevices.mockResolvedValue({ result: "listed", devices: [PIXEL] });

    await act(async () => {
      for (const push of [...pushes]) push();
    });

    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("iPad")).toBeNull();
  });

  it("lands on Pair a phone for a request made before the list was read (#16200)", async () => {
    const read = deferred<DecisionsDevicesResult>();
    listDevices.mockReturnValue(read.promise);
    const onPairFocused = vi.fn();
    render(
      <TooltipProvider>
        <DecisionsDevicesAndHosts
          status={STATUS}
          pairFocusRequest={1}
          onPairFocused={onPairFocused}
        />
      </TooltipProvider>
    );
    expect(screen.queryByRole("button", { name: "Pair a phone" })).toBeNull();
    expect(onPairFocused).not.toHaveBeenCalled();

    await act(async () => read.resolve({ result: "listed", devices: [PIXEL] }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pair a phone" }));
    expect(onPairFocused).toHaveBeenCalledOnce();
  });

  it("lists phones and tablets under Devices and each Remote Host once, under Remote Hosts (#16222)", async () => {
    listDevices.mockResolvedValue({ result: "listed", devices: [PIXEL, STUDIO_DEVICE, IPAD] });
    listHosts.mockResolvedValue({ result: "listed", autoEnroll: true, hosts: [STUDIO] });
    await renderSection();
    await act(async () => {});

    const devices = document.getElementById("decisions-devices")!;
    const hosts = document.getElementById("decisions-hosts")!;
    expect(within(devices).getByText("Pixel 9")).toBeTruthy();
    expect(within(devices).getByText("iPad")).toBeTruthy();
    expect(within(devices).queryByText(/studio/)).toBeNull();
    expect(within(devices).queryByRole("switch")).toBeNull();
    expect(within(hosts).queryByText("Pixel 9")).toBeNull();
    expect(within(hosts).queryByRole("button", { name: "Pair a phone" })).toBeNull();
    expect(within(hosts).getAllByText("studio")).toHaveLength(1);
    expect(within(hosts).queryByText("studio.local")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Revoke studio" })).toHaveLength(1);
  });

  it("offers pairing under Devices when the relay lists only Remote Hosts", async () => {
    listDevices.mockResolvedValue({ result: "listed", devices: [STUDIO_DEVICE] });
    listHosts.mockResolvedValue({ result: "listed", autoEnroll: true, hosts: [STUDIO] });
    render(
      <TooltipProvider>
        <DecisionsDevicesAndHosts status={STATUS} />
      </TooltipProvider>
    );
    await act(async () => {});

    const devices = document.getElementById("decisions-devices")!;
    expect(within(devices).getByText(/Pair a phone to answer/)).toBeTruthy();
    expect(within(devices).queryByRole("button", { name: "Refresh devices" })).toBeNull();
    expect(within(devices).getAllByRole("button", { name: "Pair a phone" })).toHaveLength(1);
  });

  it("revokes a Remote Host from its row as a phone is revoked, saying it isn't enrolled automatically again", async () => {
    listDevices.mockResolvedValue({ result: "listed", devices: [PIXEL, STUDIO_DEVICE] });
    listHosts.mockResolvedValue({ result: "listed", autoEnroll: true, hosts: [STUDIO] });
    revokeDevice.mockResolvedValue({ result: "revoked", keyEpoch: 2 });
    await renderSection();
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "Revoke studio" }));
    const confirm = dialog();
    expect(within(confirm).getByText("Revoke 'studio'?")).toBeTruthy();
    expect(confirm.textContent).toContain("Remote Host 'studio' can no longer reach your relay");
    expect(confirm.textContent).toContain("isn't enrolled automatically again");
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Revoke device" }));
    });

    expect(revokeDevice).toHaveBeenCalledExactlyOnceWith("dev_studio");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const rotate = screen.getByRole("button", { name: "Rotate keys" });
    await waitFor(() => expect(document.activeElement).toBe(rotate));
    expect(await screen.findByText(/'studio' is revoked/)).toBeTruthy();
  });

  it("says to connect a relay first, under Devices and Remote Hosts, and shows no key until then", () => {
    render(
      <TooltipProvider>
        <DecisionsDevicesAndHosts status={{ state: "not-connected" }} />
      </TooltipProvider>
    );

    expect(screen.getByText("Connect a relay above, then pair a phone here")).toBeTruthy();
    expect(
      within(document.getElementById("decisions-hosts")!).getByText(
        "Connect a relay above, then enroll Remote Hosts here"
      )
    ).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(document.getElementById("decisions-encryption")).toBeNull();
    expect(listDevices).not.toHaveBeenCalled();
    expect(listHosts).not.toHaveBeenCalled();
  });
});
