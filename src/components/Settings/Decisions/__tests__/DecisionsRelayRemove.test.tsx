// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DecisionsRelayCheck, DecisionsStatus } from "@shared/types/decisions";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { TooltipProvider } from "@/components/ui/tooltip";

const openRelayRemoveTerminal = vi.hoisted(() => vi.fn(() => Promise.resolve("pane-1")));
const checkRelay = vi.hoisted(() => vi.fn<(url: string) => Promise<DecisionsRelayCheck>>());
const view = vi.hoisted(() => ({
  remote: false,
  homeDir: "/home/me" as string | undefined,
  project: true,
  activeWorktreeId: "wt-1" as string | null,
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/hooks/app/useHomeDir", () => ({ useHomeDir: () => ({ homeDir: view.homeDir }) }));
vi.mock("@/hooks/useHostPlatform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useHostPlatform")>()),
  isRemoteWindow: () => view.remote,
}));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "workspace-1" }));
vi.mock("@/store/viewWorkspace", () => ({
  selectViewProject: () => (view.project ? { id: "workspace-1" } : undefined),
  selectViewScratch: () => undefined,
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: unknown) => unknown) => select({}),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (select: (state: unknown) => unknown) => select({}),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (select: (state: { activeWorktreeId: string | null }) => unknown) =>
    select({ activeWorktreeId: view.activeWorktreeId }),
}));
vi.mock("../relayRemove", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relayRemove")>()),
  openRelayRemoveTerminal,
}));

import { DecisionsConnectionSection } from "../DecisionsConnectionSection";

const ORIGIN = "https://relay.example.workers.dev";
const COMPATIBLE = {
  relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.2.0" },
  daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.2.0" },
  diverges: false,
};

function renderSection(status: DecisionsStatus, onClose?: SettingsTabClose) {
  return render(
    <TooltipProvider>
      <DecisionsConnectionSection status={status} onClose={onClose} />
    </TooltipProvider>
  );
}

function removeButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: "Remove relay…" }) as HTMLButtonElement | null;
}

function removeRow(): HTMLElement {
  return document.getElementById("decisions-relay-remove")!;
}

async function check(result: DecisionsRelayCheck) {
  checkRelay.mockResolvedValue(result);
  fireEvent.change(screen.getByPlaceholderText("https://decisions.example.workers.dev"), {
    target: { value: ORIGIN },
  });
  await act(async () => {
    fireEvent.submit(
      (screen.getByPlaceholderText("https://decisions.example.workers.dev") as HTMLInputElement)
        .form!
    );
  });
}

function closingSettings() {
  let afterClose: ((closed: boolean) => void) | undefined;
  const onClose = vi.fn<SettingsTabClose>(async (next) => {
    afterClose = next;
    return true;
  });
  return { onClose, finish: (closed: boolean) => act(() => afterClose!(closed)) };
}

describe("Remove relay", () => {
  beforeEach(() => {
    openRelayRemoveTerminal.mockClear();
    checkRelay.mockReset();
    Object.assign(view, {
      remote: false,
      homeDir: "/home/me",
      project: true,
      activeWorktreeId: "wt-1",
    });
    Object.defineProperty(window, "electron", {
      value: {
        decisions: {
          checkRelay,
          getSetupCheck: () => new Promise(() => {}),
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

  it.each<[string, DecisionsStatus]>([
    ["connected", { state: "connected", relayOrigin: ORIGIN }],
    ["revoked", { state: "revoked", relayOrigin: ORIGIN }],
    ["broken past use", { state: "not-connected", relayOrigin: ORIGIN, problem: "keys" }],
  ])("is offered for the relay set up here when it's %s", (_label, status) => {
    checkRelay.mockReturnValue(new Promise(() => {}));
    renderSection(status);
    expect(removeButton()?.disabled).toBe(false);
  });

  it.each<[string, DecisionsRelayCheck]>([
    ["claimed by someone else", { result: "claimed", origin: ORIGIN, compatibility: COMPATIBLE }],
    ["never claimed", { result: "unclaimed", origin: ORIGIN, compatibility: COMPATIBLE }],
    [
      "on another protocol",
      {
        result: "incompatible",
        origin: ORIGIN,
        compatibility: { ...COMPATIBLE, diverges: true },
      },
    ],
    [
      "deployed without a claim secret",
      { result: "claim-not-configured", origin: ORIGIN, compatibility: COMPATIBLE },
    ],
  ])(
    "is offered for a checked relay that's %s, with nothing set up here",
    async (_label, result) => {
      renderSection({ state: "not-connected" });
      expect(removeButton()).toBeNull();

      await check(result);

      expect(removeButton()?.disabled).toBe(false);
    }
  );

  it("isn't offered for an address that didn't answer as a relay, nor once the address changes", async () => {
    renderSection({ state: "not-connected" });
    await check({
      result: "not-a-relay",
      origin: ORIGIN,
      endpoint: "info",
      answered: "status",
      status: 404,
    });
    expect(removeButton()).toBeNull();

    await check({ result: "unclaimed", origin: ORIGIN, compatibility: COMPATIBLE });
    expect(removeButton()).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("https://decisions.example.workers.dev"), {
      target: { value: "https://other.example.workers.dev" },
    });
    expect(removeButton()).toBeNull();
  });

  it("drops the last check's offer while another check is out", async () => {
    renderSection({ state: "not-connected" });
    await check({ result: "unclaimed", origin: ORIGIN, compatibility: COMPATIBLE });
    expect(removeButton()).not.toBeNull();

    checkRelay.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      fireEvent.submit(
        (screen.getByPlaceholderText("https://decisions.example.workers.dev") as HTMLInputElement)
          .form!
      );
    });

    expect(removeButton()).toBeNull();
  });

  it("leaves no empty group behind in a Remote Hosts window, for a checked relay either", async () => {
    view.remote = true;
    renderSection({ state: "not-connected" });
    const groups = () => document.querySelectorAll('[role="group"]').length;
    const before = groups();

    await check({ result: "unclaimed", origin: ORIGIN, compatibility: COMPATIBLE });

    expect(removeButton()).toBeNull();
    expect(groups()).toBe(before);
  });

  it("isn't offered in a Remote Hosts window", () => {
    view.remote = true;
    checkRelay.mockReturnValue(new Promise(() => {}));
    renderSection({ state: "connected", relayOrigin: ORIGIN });
    expect(removeButton()).toBeNull();
    expect(document.getElementById("decisions-relay-remove")).toBeNull();
  });

  it("says why it waits for a project, and can't take a local development relay", () => {
    view.project = false;
    checkRelay.mockReturnValue(new Promise(() => {}));
    const { unmount } = renderSection({ state: "connected", relayOrigin: ORIGIN });
    expect(removeButton()?.disabled).toBe(true);
    expect(removeRow().textContent).toMatch(/Open a project to watch the removal/);
    unmount();

    view.project = true;
    renderSection({ state: "connected", relayOrigin: "http://localhost:8787" });
    expect(removeButton()?.disabled).toBe(true);
    expect(removeRow().textContent).toMatch(/https address in Cloudflare/);
  });

  it("names the relay and what goes, then closes Settings before the removal's pane opens", async () => {
    checkRelay.mockReturnValue(new Promise(() => {}));
    const settings = closingSettings();
    renderSection({ state: "connected", relayOrigin: ORIGIN }, settings.onClose);

    fireEvent.click(removeButton()!);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Remove 'relay.example.workers.dev' from Cloudflare?");
    expect(dialog.textContent).toMatch(/Worker.*attachments.*R2 bucket/);
    expect(dialog.textContent).toMatch(/Every phone paired with it stops working/);
    expect(dialog.textContent).toMatch(/can't be undone/);
    expect(dialog.textContent).toMatch(/type the Worker's name before it deletes anything/);
    const history = screen.getByRole("checkbox", {
      name: "Also delete this computer's decision history",
    });
    expect(history.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open guided removal" }));
    });
    expect(settings.onClose).toHaveBeenCalledOnce();
    expect(openRelayRemoveTerminal).not.toHaveBeenCalled();

    settings.finish(true);
    expect(openRelayRemoveTerminal).toHaveBeenCalledExactlyOnceWith(
      { origin: ORIGIN, deleteLocalHistory: false },
      { cwd: "/home/me", worktreeId: "wt-1" }
    );
  });

  it("passes the history choice along, and starts afresh unchecked the next time", async () => {
    checkRelay.mockReturnValue(new Promise(() => {}));
    renderSection({ state: "connected", relayOrigin: ORIGIN });

    fireEvent.click(removeButton()!);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also delete this computer's decision history" })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open guided removal" }));
    });
    expect(openRelayRemoveTerminal).toHaveBeenCalledExactlyOnceWith(
      { origin: ORIGIN, deleteLocalHistory: true },
      { cwd: "/home/me", worktreeId: "wt-1" }
    );

    fireEvent.click(removeButton()!);
    expect(
      screen
        .getByRole("checkbox", { name: "Also delete this computer's decision history" })
        .getAttribute("aria-checked")
    ).toBe("false");
  });

  it("offers no history choice for a relay that isn't the one set up here", async () => {
    renderSection({ state: "not-connected" });
    await check({ result: "unclaimed", origin: ORIGIN, compatibility: COMPATIBLE });

    fireEvent.click(removeButton()!);
    expect(screen.getByRole("alertdialog").textContent).toMatch(/Nothing on this computer changes/);
    expect(screen.queryByRole("checkbox")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open guided removal" }));
    });
    expect(openRelayRemoveTerminal).toHaveBeenCalledExactlyOnceWith(
      { origin: ORIGIN, deleteLocalHistory: false },
      { cwd: "/home/me", worktreeId: "wt-1" }
    );
  });

  it("starts nothing when Settings reopens before it had gone, or the dialog is cancelled", async () => {
    checkRelay.mockReturnValue(new Promise(() => {}));
    const settings = closingSettings();
    renderSection({ state: "connected", relayOrigin: ORIGIN }, settings.onClose);

    fireEvent.click(removeButton()!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(settings.onClose).not.toHaveBeenCalled();

    fireEvent.click(removeButton()!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open guided removal" }));
    });
    settings.finish(false);

    expect(openRelayRemoveTerminal).not.toHaveBeenCalled();
    expect(removeButton()?.disabled).toBe(false);
  });
});
