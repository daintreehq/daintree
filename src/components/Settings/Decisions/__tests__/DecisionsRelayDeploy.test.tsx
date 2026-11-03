// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DecisionsRelayDeploy, DecisionsStatus } from "@shared/types/decisions";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { TooltipProvider } from "@/components/ui/tooltip";

const openRelayDeployTerminal = vi.hoisted(() => vi.fn(() => Promise.resolve("pane-1")));
const view = vi.hoisted(() => ({
  remote: false,
  homeDir: "/home/me" as string | undefined,
  project: true,
  scratch: false,
  activeWorktreeId: "wt-1" as string | null,
}));

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
import { requestRelayUrl, takePendingRelayUrlRequest } from "../relayUrlRequest";

const checkRelay = vi.fn<(url: string) => Promise<never>>();
const NOT_CONNECTED: DecisionsStatus = { state: "not-connected" };
const DEPLOYED_URL = "https://daintree-decisions-0a1b2c3d.me.workers.dev";

function withDeploy(relayDeploy: DecisionsRelayDeploy): DecisionsStatus {
  return { state: "not-connected", relayDeploy };
}

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
      value: {
        decisions: {
          checkRelay: checkRelay.mockReset().mockImplementation(() => new Promise(() => {})),
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
    takePendingRelayUrlRequest();
  });

  it("offers the guided deploy alone, saying what it asks and creates, only while no relay is set up", () => {
    const { unmount } = renderSection();

    const offer = screen.getByRole("group", { name: "Don't have a relay yet?" });
    expect(offer.textContent).toMatch(/Cloudflare's free plan is enough for one person/);
    expect(offer.textContent).toMatch(/a Worker \(the relay, its Durable Object and the phone app\)/);
    expect(offer.textContent).toMatch(/private R2 bucket/);
    expect(guidedRow().textContent).toMatch(/dictation transcription \(xAI or OpenAI\)/);
    expect(guidedRow().textContent).toMatch(/transcript cleanup \(Anthropic or OpenAI\)/);
    expect(guidedRow().textContent).toMatch(/Nothing is created until you confirm the summary/);
    expect(offer.querySelectorAll("button")).toHaveLength(1);
    expect(button("Guided deploy").disabled).toBe(false);
    expect(screen.queryByText(/Cloudflare's page|CLAIM_SECRET/)).toBeNull();
    unmount();

    renderSection({ state: "connected", relayOrigin: "https://relay.example.workers.dev" });
    expect(screen.queryByRole("group", { name: "Don't have a relay yet?" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guided deploy" })).toBeNull();
  });

  it("starts nothing while the switch is changing", () => {
    renderSection(NOT_CONNECTED, undefined, true);

    expect(button("Guided deploy").disabled).toBe(true);
  });

  it("starts no second deploy while one is asking its questions", async () => {
    renderSection(withDeploy({ id: "deploy-1", state: "running" }));

    expect(button("Guided deploy").disabled).toBe(true);
    expect(guidedRow().textContent).toMatch(/A guided deploy is running/);
    expect(document.getElementById("decisions-deploy-outcome")!.textContent).toMatch(
      /Answer its questions in its terminal/
    );
  });

  it("lets a deploy whose CLI never connected be replaced by another", () => {
    renderSection(withDeploy({ id: "deploy-1", state: "waiting" }));

    expect(button("Guided deploy").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Use this relay" })).toBeNull();
  });

  it("checks the relay a finished deploy reported, from its own row", async () => {
    renderSection(
      withDeploy({
        id: "deploy-1",
        state: "completed",
        url: DEPLOYED_URL,
        claimState: "unclaimed",
        holdsClaimSecret: true,
      })
    );
    const outcome = document.getElementById("decisions-deploy-outcome")!;
    expect(outcome.textContent).toContain(DEPLOYED_URL);
    expect(outcome.textContent).toMatch(/holds its claim secret/);

    await act(async () => {
      fireEvent.click(button("Use this relay"));
    });

    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(DEPLOYED_URL);
    expect(
      (screen.getByPlaceholderText("https://decisions.example.workers.dev") as HTMLInputElement)
        .value
    ).toBe(DEPLOYED_URL);
  });

  it("offers a failed deploy's relay for checking when it got as far as a Worker", () => {
    renderSection(
      withDeploy({
        id: "deploy-1",
        state: "failed",
        url: DEPLOYED_URL,
        claimState: "unknown",
        holdsClaimSecret: true,
        error: "wrangler deploy exited with code 1",
      })
    );

    const outcome = document.getElementById("decisions-deploy-outcome")!;
    expect(outcome.textContent).toMatch(/wrangler deploy exited with code 1\. It had created/);
    expect(button("Use this relay").disabled).toBe(false);
  });

  it("says a deploy that stopped without a result, and offers no relay it never named", () => {
    renderSection(
      withDeploy({
        id: "deploy-1",
        state: "interrupted",
        error: "The deploy stopped before the CLI said how it went",
      })
    );

    expect(document.getElementById("decisions-deploy-outcome")!.textContent).toMatch(
      /check that relay before deploying again/
    );
    expect(screen.queryByRole("button", { name: "Use this relay" })).toBeNull();
    expect(button("Guided deploy").disabled).toBe(false);
  });

  it("closes Settings first, then opens the deploy pane from home in the active worktree", async () => {
    let afterClose: ((closed: boolean) => void) | undefined;
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
    afterClose!(true);
    expect(openRelayDeployTerminal).toHaveBeenCalledExactlyOnceWith({
      cwd: "/home/me",
      worktreeId: "wt-1",
    });
  });

  it("starts nothing and can be asked again when Settings opens before it had gone", async () => {
    let afterClose: ((closed: boolean) => void) | undefined;
    const onClose = vi.fn<SettingsTabClose>(async (next) => {
      afterClose = next;
      return true;
    });
    renderSection(NOT_CONNECTED, onClose);
    await act(async () => {
      fireEvent.click(button("Guided deploy"));
    });
    expect(button("Guided deploy").getAttribute("aria-busy")).toBe("true");

    act(() => afterClose!(false));

    expect(openRelayDeployTerminal).not.toHaveBeenCalled();
    expect(button("Guided deploy").getAttribute("aria-busy")).toBeNull();
    expect(button("Guided deploy").disabled).toBe(false);
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
    [
      "a Remote Hosts window",
      { remote: true },
      /Run the guided deploy from Settings → Decisions in a local project window/,
    ],
    ["no project or scratch", { project: false }, /Open a project or a scratch here first/],
  ])("says where to run the guided deploy, in %s", (_label, overrides, reason) => {
    Object.assign(view, overrides);
    renderSection();

    expect(button("Guided deploy").disabled).toBe(true);
    expect(guidedRow().textContent).toMatch(reason);
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
  it("lands on the URL field asked for before Connection rendered", () => {
    requestRelayUrl();
    renderSection();

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("https://decisions.example.workers.dev")
    );
    expect(takePendingRelayUrlRequest()).toBe(false);
  });

  it("fills the empty URL field with the deployed relay when the deploy's pane asks", () => {
    requestRelayUrl();
    renderSection(
      withDeploy({
        id: "deploy-1",
        state: "completed",
        url: DEPLOYED_URL,
        claimState: "unclaimed",
        holdsClaimSecret: true,
      })
    );

    const field = screen.getByPlaceholderText(
      "https://decisions.example.workers.dev"
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe(DEPLOYED_URL);
    // Filled, not checked: the person checks it.
    expect(checkRelay).not.toHaveBeenCalled();
  });

  it("lands on the URL field asked for while Connection is showing", () => {
    renderSection();
    expect(document.activeElement).not.toBe(
      screen.getByPlaceholderText("https://decisions.example.workers.dev")
    );

    act(() => requestRelayUrl());

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("https://decisions.example.workers.dev")
    );
  });

  it("lands on a saved relay's row, its check", () => {
    requestRelayUrl();
    renderSection({ state: "not-connected", relayOrigin: "https://relay.example.workers.dev" });

    expect(document.activeElement).toBe(button("Check"));
  });
});
