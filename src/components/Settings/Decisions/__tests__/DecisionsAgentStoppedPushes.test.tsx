// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type {
  DecisionsDevice,
  DecisionsRelayCheck,
  DecisionsStatus,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsNotificationsSection } from "../DecisionsNotificationsSection";
import type { UseDecisionsDevicesResult } from "../useDecisionsDevices";

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

const ORIGIN = "https://decisions.example.workers.dev";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const setAgentStoppedPushes = vi.fn<(enabled: boolean) => Promise<DecisionsStatus>>();
const setHoldPhonePushes = vi.fn<(enabled: boolean) => Promise<DecisionsStatus>>();
const getStatus = vi.fn<() => Promise<DecisionsStatus>>();

/** The relay's devices as Devices last read them: unread unless a test lists some. */
function devicesRead(
  devices: DecisionsDevice[] | null,
  failure: string | null = null
): UseDecisionsDevicesResult {
  return { devices, failure, loading: false, reload: () => {} };
}

function phone(overrides: Partial<DecisionsDevice> = {}): DecisionsDevice {
  return {
    deviceId: "phone-1",
    label: "Pixel 9",
    role: "phone",
    pairedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
    pushEnabled: false,
    ...overrides,
  };
}

function checked(advertisesAgentStoppedPushes: boolean, origin = ORIGIN): DecisionsRelayCheck {
  const versions = { protocolMin: 1, protocolMax: 1, workerVersion: "0.4.0" };
  return {
    result: "claimed",
    origin,
    compatibility: { relay: versions, daintree: versions, diverges: false },
    advertisesAgentStoppedPushes,
  };
}

/** The tab's part: the status main last showed, an answer applied, a failure read again. */
function Section({
  initial,
  locked = false,
  relayCheck = null,
  devices = devicesRead(null),
}: {
  initial: DecisionsStatus;
  locked?: boolean;
  relayCheck?: DecisionsRelayCheck | null;
  devices?: UseDecisionsDevicesResult;
}) {
  const [status, setStatus] = useState(initial);
  return (
    <TooltipProvider>
      <DecisionsNotificationsSection
        status={status}
        relayCheck={relayCheck}
        devices={devices}
        locked={locked}
        onChanged={(next) => {
          if (next) setStatus(next);
          else void getStatus().then(setStatus);
        }}
      />
    </TooltipProvider>
  );
}

async function renderSection(
  initial: DecisionsStatus,
  options: {
    locked?: boolean;
    relayCheck?: DecisionsRelayCheck | null;
    devices?: UseDecisionsDevicesResult;
  } = {}
) {
  render(<Section initial={initial} {...options} />);
  await act(async () => {});
}

function described(): string {
  return (stoppedSwitch().getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

const NO_PHONE = "No paired phone or tablet has notifications turned on";
const NO_SUPPORT = "Your relay doesn't advertise support for them";

function stoppedSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Notify my phone when an agent stops/,
  }) as HTMLButtonElement;
}

function holdSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Hold phone notifications while I'm at this computer/,
  }) as HTMLButtonElement;
}

const on = () => stoppedSwitch().getAttribute("aria-checked");

function resetButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: "Stop notifying my phone when an agent stops" });
}

beforeEach(() => {
  setAgentStoppedPushes.mockReset();
  setHoldPhonePushes.mockReset();
  getStatus.mockReset();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: {
        setAgentStoppedPushes,
        setHoldPhonePushes,
        getStatus,
      },
      events: { on: () => () => {} },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("Decisions agent-stopped pushes switch (#17319)", () => {
  it("is off by default, and says what reaches the phone and when", async () => {
    await renderSection({ state: "connected", consentedAt: 5 });
    expect(on()).toBe("false");
    expect(resetButton()).toBeNull();
    const text = described();
    for (const promise of ["While you're away", "outside quiet hours", "never which one"]) {
      expect(text, promise).toContain(promise);
    }
    // Which Hosts can report a stop: only those this computer is connected to (#17933).
    for (const scope of [
      "this computer and the Remote Hosts it's connected to",
      "one with a project open here, or with its notifications turned on",
    ]) {
      expect(text, scope).toContain(scope);
    }
    // Nothing read yet says nothing about what can't take effect.
    expect(text).not.toContain(NO_PHONE);
    expect(text).not.toContain(NO_SUPPORT);
  });

  describe("what keeps it from reaching a phone (#18061)", () => {
    const status: DecisionsStatus = {
      state: "connected",
      relayOrigin: ORIGIN,
      agentStoppedPushes: true,
    };

    it("says no phone has notifications on when the relay lists none with them, a tablet counting", async () => {
      await renderSection(status, {
        devices: devicesRead([
          phone(),
          phone({ deviceId: "host-1", label: "Studio", role: "desktop-host", pushEnabled: true }),
        ]),
      });
      expect(described()).toContain(NO_PHONE);
      expect(stoppedSwitch().disabled).toBe(false);
      expect(on()).toBe("true");
      cleanup();

      await renderSection(status, {
        devices: devicesRead([
          phone(),
          phone({ deviceId: "tablet-1", role: "tablet", pushEnabled: true }),
        ]),
      });
      expect(described()).not.toContain(NO_PHONE);
    });

    it("says nothing about phones before a list is read, or when the latest read failed", async () => {
      await renderSection(status, { devices: devicesRead(null) });
      expect(described()).not.toContain(NO_PHONE);
      cleanup();

      await renderSection(status, {
        devices: devicesRead([phone()], "The relay couldn't be reached"),
      });
      expect(described()).not.toContain(NO_PHONE);
    });

    it("says the relay doesn't support them only when a check of this relay found so", async () => {
      await renderSection(status, { relayCheck: checked(false) });
      expect(described()).toContain(NO_SUPPORT);
      cleanup();

      await renderSection(status, { relayCheck: checked(true) });
      expect(described()).not.toContain(NO_SUPPORT);
      cleanup();

      // A check of another relay says nothing about this one.
      await renderSection(status, {
        relayCheck: checked(false, "https://other.example.workers.dev"),
      });
      expect(described()).not.toContain(NO_SUPPORT);
      cleanup();

      await renderSection(status, {
        relayCheck: { result: "unreachable", origin: ORIGIN, endpoint: "info", reason: "timeout" },
      });
      expect(described()).not.toContain(NO_SUPPORT);
    });

    it("says both when both hold, and takes changes all the same", async () => {
      setAgentStoppedPushes.mockResolvedValueOnce({ state: "connected", relayOrigin: ORIGIN });
      await renderSection(status, { relayCheck: checked(false), devices: devicesRead([]) });
      expect(described()).toContain(NO_PHONE);
      expect(described()).toContain(NO_SUPPORT);
      await act(async () => {
        fireEvent.click(stoppedSwitch());
      });
      expect(setAgentStoppedPushes).toHaveBeenCalledExactlyOnceWith(false);
    });
  });

  it("turns on with one click, without a dialog, and off from its reset", async () => {
    setAgentStoppedPushes.mockResolvedValueOnce({
      state: "connected",
      agentStoppedPushes: true,
      revision: 1,
    });
    await renderSection({ state: "connected" });

    await act(async () => {
      fireEvent.click(stoppedSwitch());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setAgentStoppedPushes).toHaveBeenCalledExactlyOnceWith(true);
    expect(on()).toBe("true");
    // The hold switch is its own setting.
    expect(setHoldPhonePushes).not.toHaveBeenCalled();
    expect(holdSwitch().getAttribute("aria-checked")).toBe("true");

    setAgentStoppedPushes.mockResolvedValueOnce({ state: "connected", revision: 2 });
    const reset = resetButton();
    expect(reset).not.toBeNull();
    await act(async () => {
      fireEvent.click(reset!);
    });
    expect(setAgentStoppedPushes).toHaveBeenLastCalledWith(false);
    expect(on()).toBe("false");
    expect(resetButton()).toBeNull();
  });

  it("saves independently of the hold switch: one saving leaves the other free", async () => {
    const saving = deferred<DecisionsStatus>();
    setAgentStoppedPushes.mockReturnValueOnce(saving.promise);
    setHoldPhonePushes.mockResolvedValueOnce({
      state: "connected",
      holdPhonePushes: false,
      revision: 1,
    });
    await renderSection({ state: "connected" });

    fireEvent.click(stoppedSwitch());
    expect(on()).toBe("true");
    expect(stoppedSwitch().disabled).toBe(true);
    fireEvent.click(stoppedSwitch());
    expect(setAgentStoppedPushes).toHaveBeenCalledTimes(1);
    expect(holdSwitch().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(holdSwitch());
    });
    expect(setHoldPhonePushes).toHaveBeenCalledExactlyOnceWith(false);

    await act(async () => {
      saving.resolve({
        state: "connected",
        holdPhonePushes: false,
        agentStoppedPushes: true,
        revision: 2,
      });
    });
    expect(on()).toBe("true");
  });

  it("shows a failed change with Retry, and reads the status again", async () => {
    setAgentStoppedPushes.mockRejectedValueOnce(new Error("Decisions has stopped"));
    getStatus.mockResolvedValue({ state: "connected", revision: 3 });
    await renderSection({ state: "connected" });

    await act(async () => {
      fireEvent.click(stoppedSwitch());
    });
    expect(
      screen.getByText("Couldn't turn on phone notifications when an agent stops")
    ).toBeTruthy();
    expect(screen.getByText("Decisions has stopped")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(on()).toBe("false");

    setAgentStoppedPushes.mockResolvedValueOnce({
      state: "connected",
      agentStoppedPushes: true,
      revision: 4,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setAgentStoppedPushes).toHaveBeenLastCalledWith(true);
    expect(
      screen.queryByText("Couldn't turn on phone notifications when an agent stops")
    ).toBeNull();
    expect(on()).toBe("true");
  });

  it("changes nothing while the Decisions switch is changing", async () => {
    await renderSection({ state: "connected" }, { locked: true });
    fireEvent.click(stoppedSwitch());
    expect(setAgentStoppedPushes).not.toHaveBeenCalled();
    expect(on()).toBe("false");
  });
});
