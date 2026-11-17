// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostSettingKey,
  HostSettingsSnapshot,
  HostSettingsUpdatePayload,
  HostSettingsUpdateResult,
} from "@shared/types/hostSettings";
import type { HostIdleObservation } from "@shared/types/hostIdle";
import { SettingsGroup } from "../../SettingsGroup";
import { HostIdleTimeRow } from "../HostIdleTimeRow";

const api = {
  read: vi.fn<(payload: { hostId: string; keys?: HostSettingKey[] }) => Promise<HostSettingsSnapshot>>(),
  update: vi.fn<(payload: HostSettingsUpdatePayload) => Promise<HostSettingsUpdateResult>>(),
};

function snapshot(minutes: number | null, revision = `r-${minutes}`): HostSettingsSnapshot {
  return {
    hostId: "boat-1",
    hostName: "Boat",
    scope: "host",
    instanceId: "launch-1",
    unavailable: minutes === null ? ["hostIdle.idleAfterMinutes"] : [],
    settings:
      minutes === null ? [] : [{ key: "hostIdle.idleAfterMinutes", value: minutes, revision }],
  };
}

function result(
  outcome: HostSettingsUpdateResult["outcome"],
  minutes: number
): HostSettingsUpdateResult {
  return {
    hostId: "boat-1",
    hostName: "Boat",
    scope: "host",
    outcome,
    confirmedBy: "reply",
    instanceId: "launch-1",
    settings: [{ key: "hostIdle.idleAfterMinutes", value: minutes, revision: `r-${minutes}` }],
  };
}

async function renderRow(
  props: { connected?: boolean; idle?: HostIdleObservation; sampledAt?: number | null } = {}
) {
  await act(async () => {
    render(
      <SettingsGroup>
        <HostIdleTimeRow
          hostId="boat-1"
          hostName="Boat"
          connected={props.connected ?? true}
          idle={props.idle}
          sampledAt={props.sampledAt ?? null}
        />
      </SettingsGroup>
    );
  });
}

const select = () => screen.getByRole("combobox", { name: "Idle after" });

async function pick(name: string) {
  await act(async () => {
    fireEvent.keyDown(select(), { key: "ArrowDown" });
  });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" });
  });
}

beforeEach(() => {
  api.read.mockReset();
  api.update.mockReset();
  Object.defineProperty(window, "electron", {
    value: { hostSettings: api },
    configurable: true,
    writable: true,
  });
});

afterEach(cleanup);

describe("HostIdleTimeRow (#17357)", () => {
  it("reads only the idle time from the host, and changes it against the revision it read", async () => {
    api.read.mockResolvedValue(snapshot(30));
    api.update.mockResolvedValue(result("applied", 120));
    await renderRow();

    expect(api.read).toHaveBeenCalledWith({ hostId: "boat-1", keys: ["hostIdle.idleAfterMinutes"] });
    expect(select().textContent).toBe("30 minutes");
    await pick("2 hours");

    expect(api.update).toHaveBeenCalledWith({
      hostId: "boat-1",
      patch: { "hostIdle.idleAfterMinutes": 120 },
      expect: { instanceId: "launch-1", revisions: { "hostIdle.idleAfterMinutes": "r-30" } },
    });
    expect(select().textContent).toBe("2 hours");
  });

  it("shows the host's value after a conflict, and says why the change didn't land", async () => {
    api.read.mockResolvedValue(snapshot(30));
    api.update.mockResolvedValue(result("conflict", 60));
    await renderRow();
    await pick("4 hours");

    expect(select().textContent).toBe("1 hour");
    expect(document.body.textContent).toContain("This changed on Boat since it was read");
  });

  it("shows when the idle time ends once the host reports itself idle", async () => {
    api.read.mockResolvedValue(snapshot(30));
    const lastWorkAt = Date.UTC(2026, 10, 17, 14, 2);
    await renderRow({
      idle: { idleAfterMinutes: 30, lastWorkAt, busy: false, idleEndsAt: lastWorkAt + 30 * 60_000 },
      sampledAt: lastWorkAt + 60_000,
    });

    expect(document.body.textContent).toContain("Idle since");
    expect(document.body.textContent).toContain("Its idle time ends");
  });

  it("names the update a host from before the setting needs, and offers no value", async () => {
    api.read.mockResolvedValue(snapshot(null));
    await renderRow();

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.body.textContent).toContain("Needs a newer Daintree on Boat");
  });

  it("reads nothing and offers nothing to change while the host isn't connected", async () => {
    await renderRow({ connected: false });

    expect(api.read).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.body.textContent).toContain("Connect to see or change it");
  });

  it("offers Retry when the read fails, and reads again", async () => {
    api.read.mockRejectedValueOnce(new Error("link dropped"));
    api.read.mockResolvedValueOnce(snapshot(30));
    await renderRow();
    expect(screen.getByRole("alert").textContent).toContain("link dropped");
    expect(screen.queryByRole("combobox")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(select().textContent).toBe("30 minutes");
  });
});
