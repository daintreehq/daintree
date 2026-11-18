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
import { clockTime } from "@/components/Hosts/cloud/cloudHostLabels";
import { SettingsGroup } from "../../SettingsGroup";
import { HostIdleTimeRow } from "../HostIdleTimeRow";

const api = {
  read: vi.fn<
    (payload: { hostId: string; keys?: HostSettingKey[] }) => Promise<HostSettingsSnapshot>
  >(),
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
  props: {
    connected?: boolean;
    idle?: HostIdleObservation;
    sampledAt?: number | null;
    selfStopProblem?: string | null;
  } = {}
) {
  const tree = (connected: boolean) => (
    <SettingsGroup>
      <HostIdleTimeRow
        hostId="boat-1"
        hostName="Boat"
        connected={connected}
        idle={props.idle}
        sampledAt={props.sampledAt ?? null}
        selfStopProblem={props.selfStopProblem}
      />
    </SettingsGroup>
  );
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(tree(props.connected ?? true));
  });
  return {
    setConnected: async (connected: boolean) => {
      await act(async () => {
        rendered!.rerender(tree(connected));
      });
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const isDisabled = (element: HTMLElement) =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

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

    expect(api.read).toHaveBeenCalledWith({
      hostId: "boat-1",
      keys: ["hostIdle.idleAfterMinutes"],
    });
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

    expect(document.body.textContent).toContain(
      `Idle since ${clockTime(new Date(lastWorkAt).toISOString())}. Its idle time ends ${clockTime(new Date(lastWorkAt + 30 * 60_000).toISOString())}.`
    );
  });

  it("says why the machine can't stop itself, until its host says it holds a key (#17361)", async () => {
    api.read.mockResolvedValue(snapshot(30));
    const lastWorkAt = Date.UTC(2026, 10, 17, 14, 2);
    const idle = {
      idleAfterMinutes: 30,
      lastWorkAt,
      busy: false,
      idleEndsAt: lastWorkAt + 30 * 60_000,
    };
    const problem = "This machine can't stop itself when idle: the key isn't allowed.";
    await renderRow({ idle, sampledAt: lastWorkAt + 60_000, selfStopProblem: problem });
    expect(document.body.textContent).toContain(
      `Its idle time ends ${clockTime(new Date(lastWorkAt + 30 * 60_000).toISOString())}. ${problem}`
    );

    cleanup();
    await renderRow({
      idle: { ...idle, stopsWhenIdle: true },
      sampledAt: lastWorkAt + 60_000,
      selfStopProblem: problem,
    });
    expect(document.body.textContent).toContain("if it stays idle.");
    expect(document.body.textContent).not.toContain(problem);

    // Opened while disconnected: nothing read from the host, the reason still said.
    cleanup();
    await renderRow({ connected: false, selfStopProblem: problem });
    expect(document.body.textContent).toContain(`Connect to see or change it. ${problem}`);
  });

  it("names the update a host from before the setting needs, from the refusal such a host gives", async () => {
    // Asked only for a key it doesn't know, an older host's read is refused outright.
    api.read.mockRejectedValue(
      Object.assign(new Error("The host doesn't know that setting"), {
        name: "AppError",
        code: "UNSUPPORTED",
      })
    );
    await renderRow();

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.body.textContent).toContain("Needs a newer Daintree on Boat");
  });

  it("keeps a reading from before a drop locked until a read after it answers", async () => {
    const late = deferred<HostSettingsSnapshot>();
    const again = deferred<HostSettingsSnapshot>();
    api.read.mockResolvedValueOnce(snapshot(30));
    api.read.mockReturnValueOnce(late.promise);
    api.read.mockReturnValueOnce(again.promise);
    const row = await renderRow();
    expect(isDisabled(select())).toBe(false);

    // Re-read on a reconnect, then dropped before the answer came.
    await row.setConnected(false);
    await row.setConnected(true);
    await row.setConnected(false);
    await act(async () => {
      late.resolve(snapshot(60));
    });
    expect(select().textContent).toBe("30 minutes");

    await row.setConnected(true);
    expect(isDisabled(select())).toBe(true);
    await act(async () => {
      again.resolve(snapshot(120));
    });
    expect(select().textContent).toBe("2 hours");
    expect(isDisabled(select())).toBe(false);
  });

  it("says a change didn't land when the host restarted since it was read, and shows its value", async () => {
    api.read.mockResolvedValueOnce(snapshot(30));
    api.read.mockResolvedValueOnce({ ...snapshot(45, "r-b"), instanceId: "launch-2" });
    api.update.mockResolvedValue({ ...result("conflict", 45), instanceId: "launch-2" });
    await renderRow();
    await pick("4 hours");

    expect(api.read).toHaveBeenCalledTimes(2);
    expect(select().textContent).toBe("45 minutes");
    expect(document.body.textContent).toContain("This changed on Boat since it was read");
  });

  it("drops a change's answer that comes after a link drop, keeping the reading taken since", async () => {
    const late = deferred<HostSettingsUpdateResult>();
    api.read.mockResolvedValueOnce(snapshot(30));
    api.read.mockResolvedValueOnce(snapshot(60));
    api.update.mockReturnValueOnce(late.promise);
    const row = await renderRow();
    await pick("4 hours");

    await row.setConnected(false);
    await row.setConnected(true);
    expect(select().textContent).toBe("1 hour");
    await act(async () => {
      late.resolve(result("applied", 240));
    });
    expect(select().textContent).toBe("1 hour");
    expect(isDisabled(select())).toBe(false);
    expect(screen.queryByText(/didn't/)).toBeNull();

    // A refusal from before the drop says nothing about the reading taken since.
    const refused = deferred<HostSettingsUpdateResult>();
    api.update.mockReturnValueOnce(refused.promise);
    api.read.mockResolvedValueOnce(snapshot(15));
    await pick("8 hours");
    await row.setConnected(false);
    await row.setConnected(true);
    await act(async () => {
      refused.reject(new Error("link closed"));
    });
    expect(select().textContent).toBe("15 minutes");
    expect(isDisabled(select())).toBe(false);
    expect(screen.queryByText(/link closed/)).toBeNull();
  });

  it("says nothing stale when an unconfirmed change's read-back fails after the link came back", async () => {
    const readback = deferred<HostSettingsSnapshot>();
    api.read.mockResolvedValueOnce(snapshot(30));
    api.read.mockReturnValueOnce(readback.promise);
    api.read.mockResolvedValueOnce(snapshot(240));
    api.update.mockResolvedValueOnce({ ...result("unconfirmed", 30), confirmedBy: null });
    const row = await renderRow();
    await pick("4 hours");

    await row.setConnected(false);
    await row.setConnected(true);
    expect(select().textContent).toBe("4 hours");
    await act(async () => {
      readback.resolve(snapshot(30));
    });
    expect(select().textContent).toBe("4 hours");
    expect(isDisabled(select())).toBe(false);
    expect(screen.queryByText(/didn't confirm/)).toBeNull();
  });

  it("says an unconfirmed change couldn't be checked, with Retry to read the host again", async () => {
    api.read.mockResolvedValueOnce(snapshot(30));
    api.read.mockRejectedValueOnce(new Error("link dropped"));
    api.read.mockResolvedValueOnce(snapshot(240));
    api.update.mockResolvedValueOnce({ ...result("unconfirmed", 30), confirmedBy: null });
    await renderRow();
    await pick("4 hours");

    // Nothing to edit against until the host is read again, and why.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("link dropped");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(select().textContent).toBe("4 hours");
    expect(isDisabled(select())).toBe(false);
  });

  it("offers Retry when a read after a reconnect fails, with nothing editable meanwhile", async () => {
    api.read.mockResolvedValueOnce(snapshot(30));
    api.read.mockRejectedValueOnce(new Error("link dropped"));
    api.read.mockResolvedValueOnce(snapshot(60));
    const row = await renderRow();
    await row.setConnected(false);
    await row.setConnected(true);

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("link dropped");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(select().textContent).toBe("1 hour");
    expect(isDisabled(select())).toBe(false);
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
