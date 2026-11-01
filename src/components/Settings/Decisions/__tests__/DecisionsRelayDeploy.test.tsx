// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DecisionsStatus } from "@shared/types/decisions";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { TooltipProvider } from "@/components/ui/tooltip";

const dispatch = vi.hoisted(() => vi.fn());
const openRelayDeployTerminal = vi.hoisted(() => vi.fn(() => Promise.resolve("pane-1")));
const view = vi.hoisted(() => ({
  remote: false,
  homeDir: "/home/me" as string | undefined,
  project: true,
  scratch: false,
  activeWorktreeId: "wt-1" as string | null,
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/hooks/app/useHomeDir", () => ({ useHomeDir: () => ({ homeDir: view.homeDir }) }));
vi.mock("@/hooks/useHostPlatform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useHostPlatform")>()),
  isRemoteWindow: () => view.remote,
}));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "workspace-1" }));
vi.mock("@/store/viewWorkspace", () => ({
  selectViewProject: () => (view.project ? { id: "workspace-1" } : undefined),
  selectViewScratch: () => (view.scratch ? { id: "workspace-1" } : undefined),
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
vi.mock("../relayDeploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relayDeploy")>()),
  openRelayDeployTerminal,
}));

import { DecisionsConnectionSection } from "../DecisionsConnectionSection";
import { DEPLOY_TO_CLOUDFLARE_URL } from "../relayDeploy";

const NOT_CONNECTED: DecisionsStatus = { state: "not-connected" };

function renderSection(
  status: DecisionsStatus = NOT_CONNECTED,
  onClose?: SettingsTabClose,
  locked = false
) {
  return render(
    <TooltipProvider>
      <DecisionsConnectionSection status={status} locked={locked} onClose={onClose} />
    </TooltipProvider>
  );
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function guidedRow(): HTMLElement {
  return document.getElementById("decisions-deploy-guided")!;
}

describe("Decisions relay deploy offer", () => {
  beforeEach(() => {
    dispatch.mockReset();
    openRelayDeployTerminal.mockClear();
    Object.assign(view, {
      remote: false,
      homeDir: "/home/me",
      project: true,
      scratch: false,
      activeWorktreeId: "wt-1",
    });
    Object.defineProperty(window, "electron", {
      // A saved relay is checked on mount; that check never answers here.
      value: { decisions: { checkRelay: vi.fn(() => new Promise(() => {})) } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("offers both routes, with the cost and what they create, only while no relay is set up", () => {
    const { unmount } = renderSection();

    const offer = screen.getByRole("group", { name: "Don't have a relay yet?" });
    expect(offer.textContent).toMatch(/Cloudflare's free plan is enough for one person/);
    expect(offer.textContent).toMatch(/a Worker, its Durable Object and a private R2 bucket/);
    expect(button("Deploy to Cloudflare").disabled).toBe(false);
    expect(button("Guided deploy").disabled).toBe(false);
    unmount();

    renderSection({ state: "connected", relayOrigin: "https://relay.example.workers.dev" });
    expect(screen.queryByRole("group", { name: "Don't have a relay yet?" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guided deploy" })).toBeNull();
  });

  it("starts nothing while the switch is changing", () => {
    renderSection(NOT_CONNECTED, undefined, true);

    expect(button("Deploy to Cloudflare").disabled).toBe(true);
    expect(button("Guided deploy").disabled).toBe(true);
  });

  it("opens Cloudflare's page, says what's next, and hands focus to the URL field", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    renderSection();

    expect(screen.getByText(/It asks for one secret, CLAIM_SECRET/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(button("Deploy to Cloudflare"));
    });

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "system.openExternal",
      { url: DEPLOY_TO_CLOUDFLARE_URL },
      { source: "user" }
    );
    expect(document.getElementById("decisions-deploy-next")).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("https://decisions.example.workers.dev")
    );
  });

  it("says when Cloudflare's page couldn't open, and claims nothing came next", async () => {
    dispatch.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No browser" },
    });
    renderSection();

    await act(async () => {
      fireEvent.click(button("Deploy to Cloudflare"));
    });

    expect(screen.getByText("Couldn't open Cloudflare's deploy page. No browser")).toBeTruthy();
    expect(document.getElementById("decisions-deploy-next")).toBeNull();
  });

  it("closes Settings first, then opens the deploy pane from home in the active worktree", async () => {
    let afterClose: (() => void) | undefined;
    const onClose = vi.fn<SettingsTabClose>(async (next) => {
      afterClose = next;
      return true;
    });
    renderSection(NOT_CONNECTED, onClose);

    await act(async () => {
      fireEvent.click(button("Guided deploy"));
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(openRelayDeployTerminal).not.toHaveBeenCalled();
    afterClose!();
    expect(openRelayDeployTerminal).toHaveBeenCalledExactlyOnceWith({
      cwd: "/home/me",
      worktreeId: "wt-1",
    });
  });

  it("starts nothing when unsaved settings hold the close, and can be asked again", async () => {
    const onClose = vi.fn<SettingsTabClose>(async () => false);
    renderSection(NOT_CONNECTED, onClose);

    await act(async () => {
      fireEvent.click(button("Guided deploy"));
    });

    expect(openRelayDeployTerminal).not.toHaveBeenCalled();
    expect(button("Guided deploy").disabled).toBe(false);
  });

  it("asks to close only once for a double click", async () => {
    const onClose = vi.fn<SettingsTabClose>(() => new Promise<boolean>(() => {}));
    renderSection(NOT_CONNECTED, onClose);

    await act(async () => {
      fireEvent.click(button("Guided deploy"));
    });
    await act(async () => {
      fireEvent.click(button("Guided deploy"));
    });

    expect(onClose).toHaveBeenCalledOnce();
    // Busy rather than natively disabled, so it keeps focus while Settings closes.
    expect(button("Guided deploy").getAttribute("aria-busy")).toBe("true");
  });

  it("opens a scratch's pane with no worktree", async () => {
    Object.assign(view, { project: false, scratch: true, activeWorktreeId: null });
    renderSection();

    await act(async () => {
      fireEvent.click(button("Guided deploy"));
    });

    expect(openRelayDeployTerminal).toHaveBeenCalledExactlyOnceWith({
      cwd: "/home/me",
      worktreeId: undefined,
    });
  });

  it.each([
    ["a Remote Hosts window", { remote: true }, /run on its Remote Host/],
    ["no project or scratch", { project: false }, /Open a project to watch the deploy/],
  ])("keeps the guided deploy for a local window, in %s", (_label, overrides, reason) => {
    Object.assign(view, overrides);
    renderSection();

    expect(button("Guided deploy").disabled).toBe(true);
    expect(guidedRow().textContent).toMatch(reason);
    // Cloudflare's page doesn't need a terminal.
    expect(button("Deploy to Cloudflare").disabled).toBe(false);
  });

  it("waits for the home folder and the project's worktree before it can start", () => {
    view.homeDir = undefined;
    const { unmount } = renderSection();
    expect(button("Guided deploy").disabled).toBe(true);
    unmount();

    Object.assign(view, { homeDir: "/home/me", activeWorktreeId: null });
    renderSection();
    expect(button("Guided deploy").disabled).toBe(true);
  });
});
