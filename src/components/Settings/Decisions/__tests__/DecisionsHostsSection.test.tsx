// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DecisionsDevice } from "@shared/types/decisions";
import type {
  DecisionsHost,
  DecisionsHostEnrollResult,
  DecisionsHostsResult,
} from "@shared/types/decisionsHosts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsHostsSection, joinHostsToDevices } from "../DecisionsHostsSection";
import type { UseDecisionsDevicesResult } from "../useDecisionsDevices";
import { hostEnrollmentText, hostFailureText } from "../hostsCopy";

function host(overrides: Partial<DecisionsHost> = {}): DecisionsHost {
  return {
    hostId: "studio",
    name: "studio",
    connected: true,
    enrollment: { state: "not-enrolled" },
    canEnroll: true,
    ...overrides,
  };
}

function listed(hosts: DecisionsHost[], autoEnroll = true): DecisionsHostsResult {
  return { result: "listed", autoEnroll, hosts };
}

const listHosts = vi.fn<() => Promise<DecisionsHostsResult>>();
const enrollHost =
  vi.fn<
    (payload: { hostId: string; allowWeakStorage?: boolean }) => Promise<DecisionsHostEnrollResult>
  >();
const setAutoEnrollHosts = vi.fn<(enabled: boolean) => Promise<DecisionsHostsResult>>();
const listDevices = vi.fn();

function relayDevice(overrides: Partial<DecisionsDevice> = {}): DecisionsDevice {
  return {
    deviceId: "dev_x",
    label: "studio",
    role: "desktop-host",
    pairedAt: "2026-10-30T00:00:00.000Z",
    lastSeenAt: null,
    pushEnabled: false,
    ...overrides,
  };
}

/** The relay's device list as the coordinator hands it down; no reads of its own here. */
function devicesRead(devices: DecisionsDevice[] | null = []): UseDecisionsDevicesResult {
  return { devices, failure: null, loading: false, reload: () => {} };
}

beforeEach(() => {
  listHosts.mockReset();
  enrollHost.mockReset();
  setAutoEnrollHosts.mockReset();
  listDevices.mockReset();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: { listHosts, enrollHost, setAutoEnrollHosts, listDevices },
      events: { on: () => () => {} },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

async function renderGroup(
  props: {
    enabled?: boolean;
    revision?: number;
    onEnrolledChange?: () => void;
    devices?: DecisionsDevice[] | null;
    onRevoke?: () => void;
  } = {}
) {
  const view = render(
    <TooltipProvider>
      <DecisionsHostsSection
        enabled={props.enabled ?? true}
        revision={props.revision ?? 1}
        devicesRead={devicesRead(props.devices)}
        onRevoke={props.onRevoke ?? (() => {})}
        onEnrolledChange={props.onEnrolledChange}
      />
    </TooltipProvider>
  );
  await act(async () => {});
  return view;
}

function autoSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Enroll Remote Hosts automatically/,
  }) as HTMLButtonElement;
}

function enrollButtons(): HTMLButtonElement[] {
  return screen.queryAllByRole("button", { name: "Enroll" }) as HTMLButtonElement[];
}

describe("Remote Hosts", () => {
  it("offers a Host with no keychain the weaker storage behind a confirmation that names it", async () => {
    const wsl = host({
      hostId: "wsl",
      name: "Ubuntu (WSL)",
      enrollment: {
        state: "failed",
        failure: { reason: "weak-storage-only", detail: "No keyring", at: 1 },
      },
    });
    listHosts.mockResolvedValue(listed([wsl]));
    enrollHost.mockResolvedValue({ result: "done", host: wsl });
    await renderGroup();

    expect(screen.getByText(/It has no keychain, as Linux and WSL machines/)).toBeTruthy();
    expect(enrollButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Enroll with weaker storage…" }));
    expect(enrollHost).not.toHaveBeenCalled();
    expect(screen.getByText("Use the weaker key storage on Ubuntu (WSL)?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use weaker storage" }));
    });
    expect(enrollHost).toHaveBeenCalledExactlyOnceWith({ hostId: "wsl", allowWeakStorage: true });
  });

  it("reads nothing with no relay set up", async () => {
    await renderGroup({ enabled: false });
    expect(listHosts).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Connect a relay above, then enroll Remote Hosts here")).toBeTruthy();
  });

  it("offers Enroll only for a Host it would do something for", async () => {
    listHosts.mockResolvedValue(
      listed(
        [
          host({ hostId: "studio", name: "studio" }),
          host({
            hostId: "lab",
            name: "lab",
            enrollment: { state: "enrolled", deviceId: "dev_lab" },
            canEnroll: false,
          }),
          host({
            hostId: "old",
            name: "old",
            enrollment: { state: "needs-update" },
            canEnroll: false,
          }),
        ],
        false
      )
    );
    await renderGroup();
    expect(enrollButtons()).toHaveLength(1);
    expect(document.querySelector("#decisions-host-old")?.textContent).toContain(
      "needs a newer Daintree"
    );
    expect(autoSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("enrolls one Host on Enroll and reads the list again after", async () => {
    listHosts.mockResolvedValueOnce(listed([host()], false));
    enrollHost.mockResolvedValue({
      result: "done",
      host: host({ enrollment: { state: "enrolled", deviceId: "dev_x" }, canEnroll: false }),
    });
    listHosts.mockResolvedValueOnce(
      listed(
        [host({ enrollment: { state: "enrolled", deviceId: "dev_x" }, canEnroll: false })],
        false
      )
    );
    const onEnrolledChange = vi.fn();
    await renderGroup({ onEnrolledChange });

    await act(async () => {
      fireEvent.click(enrollButtons()[0]!);
    });
    expect(enrollHost).toHaveBeenCalledWith({ hostId: "studio" });
    expect(listHosts).toHaveBeenCalledTimes(2);
    expect(enrollButtons()).toHaveLength(0);
    // The relay's devices are read again, so the new device joins its row.
    expect(onEnrolledChange).toHaveBeenCalledTimes(1);
  });

  it("says why Enroll couldn't start, with a retry", async () => {
    listHosts.mockResolvedValue(listed([host()], false));
    enrollHost.mockResolvedValue({ result: "not-connected" });
    await renderGroup();
    await act(async () => {
      fireEvent.click(enrollButtons()[0]!);
    });
    expect(document.body.textContent).toContain("isn't connected now");
    enrollHost.mockResolvedValue({ result: "done", host: host() });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(enrollHost).toHaveBeenCalledTimes(2);
  });

  it("turns automatic enrollment off and on through main", async () => {
    listHosts.mockResolvedValue(listed([host()], true));
    setAutoEnrollHosts.mockImplementation(async (enabled) => listed([host()], enabled));
    await renderGroup();
    expect(autoSwitch().getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(autoSwitch());
    });
    expect(setAutoEnrollHosts).toHaveBeenLastCalledWith(false);
    expect(autoSwitch().getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(autoSwitch());
    });
    expect(setAutoEnrollHosts).toHaveBeenLastCalledWith(true);
    expect(autoSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("never lets an older read replace a newer one", async () => {
    let answerOlder!: (read: DecisionsHostsResult) => void;
    listHosts.mockImplementationOnce(() => new Promise((resolve) => (answerOlder = resolve)));
    const view = await renderGroup({ revision: 1 });
    listHosts.mockResolvedValueOnce(
      listed([host({ enrollment: { state: "enrolled", deviceId: "dev_x" }, canEnroll: false })])
    );
    view.rerender(
      <TooltipProvider>
        <DecisionsHostsSection
          enabled
          revision={2}
          devicesRead={devicesRead()}
          onRevoke={() => {}}
        />
      </TooltipProvider>
    );
    await act(async () => {});
    await act(async () => {
      answerOlder(listed([host({ enrollment: { state: "enrolling" }, canEnroll: false })]));
    });
    const row = document.querySelector("#decisions-host-studio")?.textContent ?? "";
    expect(row).toContain("Enrolled");
    expect(row).not.toContain("Enrolling");
  });

  it("drops rows that offered Enroll once there is no owner to enroll with", async () => {
    listHosts.mockResolvedValueOnce(listed([host()], false));
    const view = await renderGroup({ revision: 1 });
    expect(enrollButtons()).toHaveLength(1);

    listHosts.mockResolvedValueOnce({ result: "not-set-up" });
    view.rerender(
      <TooltipProvider>
        <DecisionsHostsSection
          enabled
          revision={2}
          devicesRead={devicesRead()}
          onRevoke={() => {}}
        />
      </TooltipProvider>
    );
    await act(async () => {});
    expect(enrollButtons()).toHaveLength(0);
    expect(document.body.textContent).toContain("No relay is set up on this computer");
  });

  it("reads the Hosts again with each status push, which carries an enrollment's progress", async () => {
    listHosts.mockResolvedValueOnce(
      listed([host({ enrollment: { state: "enrolling" }, canEnroll: false })])
    );
    const view = await renderGroup({ revision: 1 });
    expect(document.querySelector("#decisions-host-studio")?.textContent).toContain("Enrolling…");

    listHosts.mockResolvedValueOnce(
      listed([host({ enrollment: { state: "enrolled", deviceId: "dev_x" }, canEnroll: false })])
    );
    view.rerender(
      <TooltipProvider>
        <DecisionsHostsSection
          enabled
          revision={2}
          devicesRead={devicesRead()}
          onRevoke={() => {}}
        />
      </TooltipProvider>
    );
    await act(async () => {});
    expect(document.querySelector("#decisions-host-studio")?.textContent).toContain("Enrolled");
  });

  it("shows what an enrolled Host last reported of its own Decisions, read again with each push (#16022)", async () => {
    const enrolled: Pick<DecisionsHost, "enrollment" | "canEnroll"> = {
      enrollment: { state: "enrolled", deviceId: "dev_x" },
      canEnroll: false,
    };
    listHosts.mockResolvedValueOnce(
      listed([
        host({
          ...enrolled,
          runtime: {
            runtime: { state: "running", deviceId: "dev_x", connection: "connected" },
            at: 1,
            live: true,
          },
        }),
      ])
    );
    const view = await renderGroup({ revision: 1 });
    expect(document.querySelector("#decisions-host-studio")?.textContent).toContain(
      "It reports Decisions connected to the relay."
    );

    listHosts.mockResolvedValueOnce(
      listed([
        host({
          ...enrolled,
          runtime: {
            runtime: { state: "revoked", deviceId: "dev_x", since: 2, credentialsRemoved: true },
            at: 2,
            live: true,
          },
        }),
      ])
    );
    view.rerender(
      <TooltipProvider>
        <DecisionsHostsSection
          enabled
          revision={2}
          devicesRead={devicesRead()}
          onRevoke={() => {}}
        />
      </TooltipProvider>
    );
    await act(async () => {});
    expect(document.querySelector("#decisions-host-studio")?.textContent).toContain(
      "stopped, as the relay revoked it, and its keys removed"
    );
  });
});

describe("Remote Host copy", () => {
  it("promises a retry on the next connection only while automatic enrollment is on", () => {
    const failed = host({
      enrollment: { state: "failed", failure: { reason: "relay-unreachable", at: 1 } },
    });
    expect(hostEnrollmentText(failed, true)).toContain("Tried again when it next connects");
    expect(hostEnrollmentText(failed, false)).not.toContain("Tried again");
    // A full relay won't take it on the next connection either.
    const full = host({
      enrollment: { state: "failed", failure: { reason: "relay-full", at: 1 } },
    });
    expect(hostEnrollmentText(full, true)).not.toContain("Tried again");
  });

  it("says a Host isn't connected wherever that matters", () => {
    const away = host({ connected: false, enrollment: { state: "enrolled", deviceId: "dev_x" } });
    expect(hostEnrollmentText(away, true)).toContain("Not connected");
    expect(hostEnrollmentText({ ...away, connected: true }, true)).not.toContain("Not connected");
  });

  it("says what an enrolled Host last reported of its own Decisions, and when that was before its link closed", () => {
    const enrolled = host({ enrollment: { state: "enrolled", deviceId: "dev_x" } });
    const connected = {
      runtime: { state: "running" as const, deviceId: "dev_x", connection: "connected" as const },
      at: 1,
      live: true,
    };
    expect(hostEnrollmentText({ ...enrolled, runtime: connected }, true)).toMatch(
      /It reports Decisions connected to the relay\.$/
    );
    expect(
      hostEnrollmentText(
        { ...enrolled, connected: false, runtime: { ...connected, live: false } },
        true
      )
    ).toMatch(
      /Not connected\. Before its connection closed, it reported Decisions connected to the relay\.$/
    );
    expect(
      hostEnrollmentText(
        {
          ...enrolled,
          runtime: {
            runtime: {
              state: "running",
              deviceId: "dev_x",
              connection: "not-connected",
              problem: "keys",
            },
            at: 1,
            live: true,
          },
        },
        true
      )
    ).toContain("not connected to the relay, as its keys couldn't be read");
    expect(
      hostEnrollmentText(
        {
          ...enrolled,
          runtime: {
            runtime: { state: "revoked", deviceId: "dev_x", since: 1, credentialsRemoved: false },
            at: 1,
            live: true,
          },
        },
        true
      )
    ).toContain("its keys aren't removed yet");
    // A Host that says it isn't enrolled by this owner adds nothing to the row.
    expect(
      hostEnrollmentText(
        { ...enrolled, runtime: { runtime: { state: "not-enrolled" }, at: 1, live: true } },
        true
      )
    ).toBe(hostEnrollmentText(enrolled, true));
  });

  it("carries the Host's own words as a sentence", () => {
    expect(
      hostFailureText({ reason: "no-keychain", detail: "no keyring is available", at: 1 })
    ).toMatch(/keep its keys, so nothing was enrolled\. No keyring is available\.$/);
    expect(hostFailureText({ reason: "relay-refused", detail: "rate-limited", at: 1 })).toContain(
      "limiting requests"
    );
  });
});

describe("each Remote Host once (#16222)", () => {
  it("joins a Host to the relay's device it is enrolled as or recorded as, or else the one it reports holding", () => {
    const enrolled = host({
      hostId: "lab",
      name: "lab",
      enrollment: { state: "enrolled", deviceId: "dev_lab" },
      canEnroll: false,
    });
    const checking = host({
      hostId: "studio",
      enrollment: { state: "checking" },
      canEnroll: false,
      runtime: {
        runtime: { state: "running", deviceId: "dev_studio", connection: "connected" },
        at: 1,
        live: true,
      },
    });
    // A recorded Host whose later attempt failed before it reported anything.
    const failed = host({
      hostId: "box",
      name: "box",
      enrollment: { state: "failed", failure: { reason: "relay-unreachable", at: 1 } },
      recordedDeviceId: "dev_box",
    });
    const lab = relayDevice({ deviceId: "dev_lab", label: "lab" });
    const studio = relayDevice({ deviceId: "dev_studio" });
    const box = relayDevice({ deviceId: "dev_box", label: "box" });
    const orphan = relayDevice({ deviceId: "dev_orphan", label: "old-box" });
    const phone = relayDevice({ deviceId: "dev_phone", label: "Pixel", role: "phone" });

    const joined = joinHostsToDevices(
      [enrolled, checking, failed],
      [phone, lab, studio, box, orphan],
      true
    );

    expect(joined.rows.map((row) => row.device?.deviceId ?? null)).toEqual([
      "dev_lab",
      "dev_studio",
      "dev_box",
    ]);
    expect(joined.relayOnly.map((device) => device.deviceId)).toEqual(["dev_orphan"]);
  });

  it("shows a relay-listed Host alone only once the Hosts read has answered", async () => {
    const onRevoke = vi.fn();
    let answer!: (read: DecisionsHostsResult) => void;
    listHosts.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const studio = relayDevice({ deviceId: "dev_studio" });
    await renderGroup({ devices: [studio], onRevoke });
    expect(document.querySelector("#decisions-host-device-dev_studio")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Revoke/ })).toBeNull();

    await act(async () => {
      answer(
        listed([
          host({ enrollment: { state: "enrolled", deviceId: "dev_studio" }, canEnroll: false }),
        ])
      );
    });
    expect(document.querySelector("#decisions-host-device-dev_studio")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Revoke/ })).toHaveLength(1);
    expect(
      document.querySelector("#decisions-host-studio")?.querySelector("button")?.textContent
    ).toBe("Revoke");
  });

  it("offers Revoke on an enrolled Host's own row, naming it, with when the relay last saw it", async () => {
    const onRevoke = vi.fn();
    listHosts.mockResolvedValue(
      listed([
        host({
          hostId: "lab",
          name: "lab",
          enrollment: { state: "enrolled", deviceId: "dev_lab" },
          canEnroll: false,
          recordedDeviceId: "dev_lab",
        }),
      ])
    );
    await renderGroup({
      devices: [relayDevice({ deviceId: "dev_lab", label: "lab-cert" })],
      onRevoke,
    });

    const row = document.querySelector("#decisions-host-lab")?.textContent ?? "";
    expect(row).toContain("Enrolled as its own device");
    expect(row).toContain("Not seen since it was enrolled");
    expect(enrollButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Revoke lab" }));
    expect(onRevoke).toHaveBeenCalledExactlyOnceWith({
      deviceId: "dev_lab",
      label: "lab",
      role: "desktop-host",
      recordedHost: true,
    });
    expect(screen.queryByText("lab-cert")).toBeNull();
  });

  it("offers no Revoke on a Host that holds no device the relay lists", async () => {
    listHosts.mockResolvedValue(
      listed([
        host({ hostId: "fresh", name: "fresh" }),
        host({
          hostId: "old",
          name: "old",
          enrollment: { state: "needs-update" },
          canEnroll: false,
        }),
        host({
          hostId: "elsewhere",
          name: "elsewhere",
          enrollment: { state: "other-setup" },
          canEnroll: false,
          runtime: {
            runtime: { state: "running", deviceId: "dev_other_relay", connection: "connected" },
            at: 1,
            live: true,
          },
        }),
      ])
    );
    await renderGroup({ devices: [relayDevice({ deviceId: "dev_unrelated" })] });

    for (const id of ["fresh", "old", "elsewhere"]) {
      const row = document.querySelector(`#decisions-host-${id}`)!;
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).queryByRole("button", { name: /^Revoke/ })).toBeNull();
    }
    expect(enrollButtons()).toHaveLength(1);
  });

  it("puts Enroll and Revoke on the same row when a Host that could be enrolled still holds a listed device", async () => {
    const onRevoke = vi.fn();
    listHosts.mockResolvedValue(
      listed([
        host({
          enrollment: { state: "unchecked" },
          runtime: {
            runtime: { state: "running", deviceId: "dev_studio", connection: "connected" },
            at: 1,
            live: true,
          },
        }),
      ])
    );
    await renderGroup({ devices: [relayDevice({ deviceId: "dev_studio" })], onRevoke });

    const actions = document.querySelector<HTMLElement>(
      "#decisions-host-studio [data-settings-row-actions]"
    )!;
    const buttons = within(actions).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Enroll", "Revoke"]);
    enrollHost.mockResolvedValue({ result: "done", host: host() });
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(enrollHost).toHaveBeenCalledExactlyOnceWith({ hostId: "studio" });
    fireEvent.click(buttons[1]!);
    // Joined by what the Host reports alone: no record here keeps it from enrolling again.
    expect(onRevoke).toHaveBeenCalledExactlyOnceWith({
      deviceId: "dev_studio",
      label: "studio",
      role: "desktop-host",
      recordedHost: false,
    });
  });

  it("keeps a Host enrolled here revocable when the relay's devices are unread or don't list it", async () => {
    const onRevoke = vi.fn();
    // Enrolled, but the record of it couldn't be saved: nothing here would keep it from enrolling again.
    listHosts.mockResolvedValue(
      listed([host({ enrollment: { state: "enrolled", deviceId: "dev_x" }, canEnroll: false })])
    );
    const view = await renderGroup({ devices: null, onRevoke });
    fireEvent.click(screen.getByRole("button", { name: "Revoke studio" }));
    expect(onRevoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceId: "dev_x", recordedHost: false })
    );

    view.rerender(
      <TooltipProvider>
        <DecisionsHostsSection
          enabled
          revision={1}
          devicesRead={devicesRead([])}
          onRevoke={onRevoke}
        />
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke studio" }));
    expect(onRevoke).toHaveBeenCalledTimes(2);
    expect(onRevoke).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: "dev_x" }));
  });

  it("lists a Remote Host device the relay holds with no Host record here, and keeps it revocable when the Hosts can't be read", async () => {
    const onRevoke = vi.fn();
    listHosts.mockRejectedValue(new Error("boom"));
    await renderGroup({
      devices: [relayDevice({ deviceId: "dev_orphan", label: "old-box" })],
      onRevoke,
    });

    expect(document.body.textContent).toContain("Couldn't read the Remote Hosts");
    const row = document.querySelector("#decisions-host-device-dev_orphan")?.textContent ?? "";
    expect(row).toContain("this computer has no record of it");
    fireEvent.click(screen.getByRole("button", { name: "Revoke old-box" }));
    expect(onRevoke).toHaveBeenCalledExactlyOnceWith({
      deviceId: "dev_orphan",
      label: "old-box",
      role: "desktop-host",
    });
  });

  it("says how to add a Host when none is listed, and shows no phone", async () => {
    listHosts.mockResolvedValue(listed([]));
    await renderGroup({ devices: [relayDevice({ deviceId: "dev_phone", role: "phone" })] });

    expect(screen.getByText("Connect to a Remote Host to enroll it here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Revoke/ })).toBeNull();
  });
});
