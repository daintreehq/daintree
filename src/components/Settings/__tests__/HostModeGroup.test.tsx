// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { HostModeEvent, HostModeStatus } from "@shared/types/ipc/hostMode";

const { clientMock, supported, mac } = vi.hoisted(() => ({
  clientMock: {
    getStatus: vi.fn(),
    setEnabled: vi.fn(),
    runKeychainPreflight: vi.fn(),
    onEvent: vi.fn(),
  },
  supported: { value: true },
  mac: { value: true },
}));

vi.mock("@/clients/hostModeClient", () => ({ hostModeClient: clientMock }));
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => supported.value,
  isRemoteHostSupported: () => supported.value,
  isEitherRemoteRoleSupported: () => supported.value,
}));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => mac.value,
}));

import HostModeGroup from "../HostModeGroup";
import { TooltipProvider } from "@/components/ui/tooltip";

function makeStatus(overrides: Partial<HostModeStatus> = {}): HostModeStatus {
  return {
    supported: true,
    enabled: false,
    startAtLogin: false,
    socketPath: "/Users/g/Library/Application Support/Daintree/host.sock",
    listening: false,
    attachedClients: [],
    rows: [
      { id: "socket", state: "unknown", detail: "Not listening" },
      { id: "start-at-login", state: "unknown", detail: "Off" },
      { id: "keychain", state: "unknown", detail: "Not checked yet" },
      {
        id: "sleep",
        state: "warning",
        detail: "System sleep after 1 min (pmset -g)",
        command: "sudo pmset -a sleep 0 disksleep 0",
      },
      { id: "drivers", state: "unknown", detail: "No other machines attached" },
    ],
    ...overrides,
  };
}

const ON = makeStatus({
  enabled: true,
  listening: true,
  rows: [
    {
      id: "socket",
      state: "ok",
      detail: "Listening at /Users/g/Library/Application Support/Daintree/host.sock",
    },
    {
      id: "start-at-login",
      state: "unknown",
      detail: "Off — this machine serves other machines only while Daintree is open",
    },
    { id: "keychain", state: "ok", detail: "Keychain answered a test encrypt and decrypt" },
    {
      id: "sleep",
      state: "warning",
      detail: "System sleep after 1 min (pmset -g)",
      command: "sudo pmset -a sleep 0 disksleep 0",
    },
    { id: "drivers", state: "ok", detail: "greg-mbp (driving 1 project)" },
  ],
});

function switchFor(container: HTMLElement, name: string): HTMLButtonElement {
  return within(container).getByRole<HTMLButtonElement>("switch", { name });
}

async function renderGroup() {
  const utils = render(
    <TooltipProvider>
      <HostModeGroup />
    </TooltipProvider>
  );
  await act(async () => {});
  return utils;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  supported.value = true;
  mac.value = true;
});

describe("HostModeGroup", () => {
  it("renders nothing where this machine can't host", async () => {
    supported.value = false;
    const { container } = await renderGroup();
    expect(container.textContent).toBe("");
    expect(clientMock.getStatus).not.toHaveBeenCalled();
  });

  it("shows the switch off, start at login disabled, and no status rows while off", async () => {
    clientMock.onEvent.mockReturnValue(() => {});
    clientMock.getStatus.mockResolvedValue(makeStatus());
    const { container } = await renderGroup();

    expect(container.textContent).toContain("This machine as a host");
    const main = switchFor(container, "Allow this machine to be a host");
    expect(main.getAttribute("aria-checked")).toBe("false");
    expect(main.disabled).toBe(false);
    expect(switchFor(container, "Start at login").disabled).toBe(true);
    expect(container.textContent).toContain("Turn on hosting to start it at login");
    expect(container.querySelector("#host-mode-socket")).toBeNull();
  });

  it("turns hosting on without consenting to start at login", async () => {
    clientMock.onEvent.mockReturnValue(() => {});
    clientMock.getStatus.mockResolvedValue(makeStatus());
    clientMock.setEnabled.mockResolvedValue(ON);
    const { container } = await renderGroup();

    await act(async () => {
      fireEvent.click(switchFor(container, "Allow this machine to be a host"));
    });
    expect(clientMock.setEnabled).toHaveBeenCalledWith({ enabled: true });

    expect(
      switchFor(container, "Allow this machine to be a host").getAttribute("aria-checked")
    ).toBe("true");
    expect(container.querySelector("#host-mode-socket")?.textContent).toContain(
      "Listening at /Users/g/Library/Application Support/Daintree/host.sock"
    );
    expect(container.querySelector("#host-mode-keychain")?.textContent).toContain("Keychain");
    expect(container.querySelector("#host-mode-sleep")?.textContent).toContain(
      "sudo pmset -a sleep 0 disksleep 0"
    );
    expect(container.querySelector("#host-mode-drivers")?.textContent).toContain(
      "greg-mbp (driving 1 project)"
    );
  });

  it("asks for start at login only through its own switch", async () => {
    clientMock.onEvent.mockReturnValue(() => {});
    clientMock.getStatus.mockResolvedValue(ON);
    clientMock.setEnabled.mockResolvedValue({ ...ON, startAtLogin: true });
    const { container } = await renderGroup();

    await act(async () => {
      fireEvent.click(switchFor(container, "Start at login"));
    });
    expect(clientMock.setEnabled).toHaveBeenCalledWith({ enabled: true, startAtLogin: true });
  });

  it("follows status pushed from main", async () => {
    let push: ((event: HostModeEvent) => void) | null = null;
    clientMock.onEvent.mockImplementation((cb: (event: HostModeEvent) => void) => {
      push = cb;
      return () => {};
    });
    clientMock.getStatus.mockResolvedValue(makeStatus());
    const { container } = await renderGroup();
    act(() => push?.({ type: "status-changed", status: ON }));
    expect(container.querySelector("#host-mode-drivers")?.textContent).toContain("greg-mbp");
  });

  it("runs the keychain check on request", async () => {
    clientMock.onEvent.mockReturnValue(() => {});
    clientMock.getStatus.mockResolvedValue(ON);
    clientMock.runKeychainPreflight.mockResolvedValue(ON);
    const { container } = await renderGroup();
    const check = within(container.querySelector<HTMLElement>("#host-mode-keychain")!).getByRole(
      "button",
      { name: "Check" }
    );
    await act(async () => {
      fireEvent.click(check);
    });
    expect(clientMock.runKeychainPreflight).toHaveBeenCalledTimes(1);
  });

  it("names Linux's keyring and says why a failed switch failed, with a retry", async () => {
    mac.value = false;
    clientMock.onEvent.mockReturnValue(() => {});
    clientMock.getStatus.mockResolvedValue(makeStatus());
    clientMock.setEnabled.mockRejectedValueOnce(
      new Error("Another process is already listening on /run/user/1000/daintree/host.sock")
    );
    const { container } = await renderGroup();
    expect(container.textContent).toContain("systemd user unit");

    await act(async () => {
      fireEvent.click(switchFor(container, "Allow this machine to be a host"));
    });
    expect(container.textContent).toContain("Couldn't turn on Host mode");
    expect(container.textContent).toContain("already listening");

    clientMock.setEnabled.mockResolvedValueOnce(ON);
    const retry = within(container).getByRole("button", { name: "Retry" });
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(clientMock.setEnabled).toHaveBeenLastCalledWith({ enabled: true });
    expect(container.querySelector("#host-mode-keychain")?.textContent).toContain("Keyring");
  });
});
