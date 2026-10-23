// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginAccountRow } from "../PluginAccountRow";
import type {
  LoadedPluginInfo,
  PluginAccountContribution,
  PluginAccountUiStatus,
} from "@shared/types/plugin";

const remote = vi.hoisted(() => ({ hostId: null as string | null }));

vi.mock("@/components/Plugin/remotePluginView", () => ({
  pluginViewHostId: () => remote.hostId,
}));

vi.mock("@/hooks/useHostConnection", () => ({
  useHostConnection: () => ({ hostName: remote.hostId ? "studio-01" : null }),
}));

vi.mock("@/hooks/useHostPlatform", () => ({
  useHostPlatform: () => ({ platform: "darwin" }),
}));

const pluginApi = {
  getAccountStatus: vi.fn(),
  connectAccount: vi.fn(),
  cancelAccountConnect: vi.fn(),
  setAccountToken: vi.fn(),
  disconnectAccount: vi.fn(),
  testAccountConnection: vi.fn(),
  onSettingsChanged: vi.fn((_cb: (payload: { pluginId: string }) => void) => () => {}),
};

const OAUTH: PluginAccountContribution = {
  kind: "oauth2",
  label: "Tracker",
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  clientId: "daintree",
  scopes: [],
};

const TOKEN: PluginAccountContribution = { kind: "token", label: "Tracker" };

function status(over: Partial<PluginAccountUiStatus> = {}): PluginAccountUiStatus {
  return {
    connectionId: "default",
    kind: "oauth2",
    label: "Tracker",
    description: null,
    connected: false,
    identity: null,
    pending: false,
    secretTier: "keychain",
    testable: false,
    verification: { status: "unchecked", checkedAt: null, message: null },
    ...over,
  };
}

function plugin(account: PluginAccountContribution): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.tracker",
      displayName: "Tracker",
      version: "1.0.0",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        keybindings: [],
        contextMenus: [],
        commands: [],
        views: [],
        mcpServers: [],
        skills: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        fileEditors: [],
        agents: [],
        processTools: [],
        recipes: [],
        account,
      },
    },
    instanceId: "acme.tracker",
    origin: "global",
    projectId: null,
    dir: "/tmp/acme.tracker",
    loadedAt: 0,
    isBuiltin: false,
    source: "sideload",
    installedAt: 0,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
  };
}

/** The button named `name`, once the row has loaded enough to enable it. */
async function enabledButton(name: string): Promise<HTMLButtonElement> {
  const button = await screen.findByRole("button", { name });
  if (!(button instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

beforeEach(() => {
  remote.hostId = null;
  vi.clearAllMocks();
  pluginApi.onSettingsChanged.mockImplementation(() => () => {});
  pluginApi.getAccountStatus.mockResolvedValue(status());
  pluginApi.disconnectAccount.mockResolvedValue(undefined);
  pluginApi.cancelAccountConnect.mockResolvedValue(undefined);
  Object.defineProperty(window, "electron", {
    value: { plugin: pluginApi },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("PluginAccountRow", () => {
  it("connects through the browser and then shows who it is connected as", async () => {
    pluginApi.connectAccount.mockResolvedValue({
      status: "connected",
      account: status({ connected: true, identity: "octo" }),
    });
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);

    fireEvent.click(await enabledButton("Connect"));

    await screen.findByText(/^Connected as octo\./);
    expect(pluginApi.connectAccount).toHaveBeenCalledWith("acme.tracker", "default");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("offers Cancel while the browser sign-in is open", async () => {
    let finish!: (r: unknown) => void;
    pluginApi.connectAccount.mockReturnValue(new Promise((r) => (finish = r)));
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);
    fireEvent.click(await enabledButton("Connect"));

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(pluginApi.cancelAccountConnect).toHaveBeenCalledWith("acme.tracker", "default");
    finish({ status: "cancelled" });
    await screen.findByRole("button", { name: "Connect" });
  });

  it("shows a failed sign-in's reason on the row", async () => {
    pluginApi.connectAccount.mockResolvedValue({
      status: "failed",
      message: "Sign-in was declined in the browser",
    });
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);
    fireEvent.click(await enabledButton("Connect"));
    await screen.findByText("Sign-in was declined in the browser");
  });

  it("can't connect from a window attached to another machine", async () => {
    remote.hostId = "host-1";
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);
    await screen.findByText(/Connect from a window on studio-01/);
    expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
  });

  it("stores a pasted token and clears the field", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(status({ kind: "token" }));
    pluginApi.setAccountToken.mockResolvedValue(
      status({ kind: "token", connected: true, identity: "octo" })
    );
    render(<PluginAccountRow plugin={plugin(TOKEN)} account={TOKEN} />);

    const input = (await screen.findByPlaceholderText("API token")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "pat-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await screen.findByText(/^Connected as octo\./);
    expect(pluginApi.setAccountToken).toHaveBeenCalledWith("acme.tracker", "pat-123", "default");
    expect(screen.queryByPlaceholderText("API token")).toBeNull();
  });

  it("asks before disconnecting, then forgets the account", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(status({ connected: true, identity: "octo" }));
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(pluginApi.disconnectAccount).not.toHaveBeenCalled();
    pluginApi.getAccountStatus.mockResolvedValue(status());
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect account" }));

    await waitFor(() =>
      expect(pluginApi.disconnectAccount).toHaveBeenCalledWith("acme.tracker", "default")
    );
    await screen.findByRole("button", { name: "Connect" });
  });

  it("re-reads its status when main reports the plugin's account changed", async () => {
    const listeners: Array<(payload: { pluginId: string }) => void> = [];
    pluginApi.onSettingsChanged.mockImplementation(
      (cb: (payload: { pluginId: string }) => void) => {
        listeners.push(cb);
        return () => {};
      }
    );
    pluginApi.getAccountStatus.mockResolvedValue(status({ connected: true }));
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);
    await screen.findByText(/^Connected\./);

    pluginApi.getAccountStatus.mockResolvedValue(status());
    for (const listener of listeners) listener({ pluginId: "acme.tracker" });
    await screen.findByRole("button", { name: "Connect" });
  });

  it("picks up a browser sign-in already in progress and can cancel it", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(status({ pending: true }));
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);

    await screen.findByText("Finish signing in in your browser…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(pluginApi.cancelAccountConnect).toHaveBeenCalledWith("acme.tracker", "default");
  });

  it("says the stored tokens aren't checked until a test passes", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(
      status({ connected: true, identity: "octo", testable: true })
    );
    pluginApi.testAccountConnection.mockResolvedValue({
      status: "rejected",
      checkedAt: 1,
      message: "The service refused the stored token (HTTP 401)",
    });
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);

    await screen.findByText(/not checked against the service yet/);
    fireEvent.click(await enabledButton("Test"));
    await screen.findByText(/refused the stored token \(HTTP 401\)/);
    expect(pluginApi.testAccountConnection).toHaveBeenCalledWith("acme.tracker", "default");
    // A refusal doesn't disconnect: Reconnect and Disconnect stay offered.
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("offers no Test when the manifest declares nothing to ask", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(status({ connected: true }));
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);
    await screen.findByRole("button", { name: "Reconnect" });
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
  });

  it("replaces a pasted token from Reconnect", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(status({ kind: "token", connected: true }));
    pluginApi.setAccountToken.mockResolvedValue(status({ kind: "token", connected: true }));
    render(<PluginAccountRow plugin={plugin(TOKEN)} account={TOKEN} connectionId="work" />);

    fireEvent.click(await enabledButton("Reconnect"));
    const input = (await screen.findByPlaceholderText("API token")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "pat-456" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() =>
      expect(pluginApi.setAccountToken).toHaveBeenCalledWith("acme.tracker", "pat-456", "work")
    );
    await waitFor(() => expect(screen.queryByPlaceholderText("API token")).toBeNull());
  });

  it("says why a revoked connection needs connecting again", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(
      status({ verification: { status: "revoked", checkedAt: 1, message: null } })
    );
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);
    await screen.findByText("The service ended this sign-in. Connect again to use it");
  });

  it("shows a Reconnect another window started as a sign-in to cancel", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(status({ connected: true, pending: true }));
    render(<PluginAccountRow plugin={plugin(OAUTH)} account={OAUTH} />);
    await screen.findByText("Finish signing in in your browser…");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(pluginApi.cancelAccountConnect).toHaveBeenCalledWith("acme.tracker", "default");
  });

  it("drops a refused replacement's error when the replacement is cancelled", async () => {
    pluginApi.getAccountStatus.mockResolvedValue(status({ kind: "token", connected: true }));
    pluginApi.setAccountToken.mockRejectedValue(new Error("The service didn't accept this token"));
    render(<PluginAccountRow plugin={plugin(TOKEN)} account={TOKEN} />);

    fireEvent.click(await enabledButton("Reconnect"));
    fireEvent.change(await screen.findByPlaceholderText("API token"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await screen.findByText("The service didn't accept this token");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("The service didn't accept this token")).toBeNull()
    );
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});
