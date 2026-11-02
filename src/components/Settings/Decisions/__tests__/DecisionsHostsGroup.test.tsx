// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DecisionsDevice, DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionsHost,
  DecisionsHostEnrollResult,
  DecisionsHostsResult,
} from "@shared/types/decisionsHosts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsDevicesSection } from "../DecisionsDevicesSection";
import { DecisionsHostsGroup } from "../DecisionsHostsGroup";
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
const enrollHost = vi.fn<(payload: { hostId: string }) => Promise<DecisionsHostEnrollResult>>();
const setAutoEnrollHosts = vi.fn<(enabled: boolean) => Promise<DecisionsHostsResult>>();
const listDevices = vi.fn();

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
  props: { enabled?: boolean; revision?: number; onEnrolledChange?: () => void } = {}
) {
  const view = render(
    <TooltipProvider>
      <DecisionsHostsGroup
        enabled={props.enabled ?? true}
        revision={props.revision ?? 1}
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

describe("Remote Hosts under Devices", () => {
  it("reads nothing with no relay set up", async () => {
    await renderGroup({ enabled: false });
    expect(listHosts).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).toBeNull();
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
    // The device list above is read again, so the new device shows there.
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
        <DecisionsHostsGroup enabled revision={2} />
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
        <DecisionsHostsGroup enabled revision={2} />
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
        <DecisionsHostsGroup enabled revision={2} />
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
        <DecisionsHostsGroup enabled revision={2} />
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

describe("an enrolled Remote Host in the device list", () => {
  it("drops the phone's notification advice", async () => {
    const devices: DecisionsDevice[] = [
      {
        deviceId: "dev_host",
        label: "studio",
        role: "desktop-host",
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        pushEnabled: false,
      },
      {
        deviceId: "dev_phone",
        label: "Greg's iPhone",
        role: "phone",
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        pushEnabled: false,
      },
    ];
    listDevices.mockResolvedValue({ result: "listed", devices });
    listHosts.mockResolvedValue(listed([]));
    const status: DecisionsStatus = {
      state: "connected",
      relayOrigin: "https://r.example",
      revision: 1,
    };
    render(
      <TooltipProvider>
        <DecisionsDevicesSection status={status} />
      </TooltipProvider>
    );
    await act(async () => {});
    const hostRow = document.querySelector("#decisions-device-dev_host")?.textContent ?? "";
    const phoneRow = document.querySelector("#decisions-device-dev_phone")?.textContent ?? "";
    expect(hostRow).toContain("Remote Host");
    expect(hostRow).not.toContain("notifications");
    expect(phoneRow).toContain("No notifications");
  });
});
