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
import { DecisionsDevicesSection } from "../DecisionsDevicesSection";

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

const listDevices = vi.fn<() => Promise<DecisionsDevicesResult>>();
const revokeDevice = vi.fn<(deviceId: string) => Promise<DecisionsRevokeDeviceResult>>();
const rotateKeys = vi.fn<() => Promise<DecisionsRotateKeysResult>>();
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
      <DecisionsDevicesSection status={STATUS} />
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

describe("DecisionsDevicesSection revoke and rotate (#16010)", () => {
  beforeEach(() => {
    pushes.clear();
    listDevices.mockReset().mockResolvedValue({ result: "listed", devices: [PIXEL, IPAD] });
    revokeDevice.mockReset();
    rotateKeys.mockReset();
    Object.defineProperty(window, "electron", {
      value: {
        decisions: { listDevices, revokeDevice, rotateKeys },
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
        <DecisionsDevicesSection status={STATUS} />
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
});
