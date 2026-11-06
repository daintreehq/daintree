// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  ClaimDeployedDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsRelayDeploy,
  DecisionsStatus,
} from "@shared/types/decisions";
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
const claimDeployedRelay =
  vi.fn<(payload: ClaimDeployedDecisionsRelayPayload) => Promise<DecisionsConnectResult>>();
const NOT_CONNECTED: DecisionsStatus = { state: "not-connected" };
const DEPLOYED_URL = "https://daintree-decisions-0a1b2c3d.me.workers.dev";

function withDeploy(relayDeploy: DecisionsRelayDeploy): DecisionsStatus {
  return { state: "not-connected", relayDeploy };
}

function renderSection(
  status: DecisionsStatus = NOT_CONNECTED,
  onClose?: SettingsTabClose,
  locked = false,
  onChanged?: (status: DecisionsStatus | null) => void
) {
  return render(
    <TooltipProvider>
      <DecisionsConnectionSection
        status={status}
        locked={locked}
        onClose={onClose}
        onChanged={onChanged}
      />
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
          claimDeployedRelay: claimDeployedRelay.mockReset(),
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
    expect(offer.textContent).toMatch(
      /a Worker \(the relay, its Durable Object and the phone app\)/
    );
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

  it("lets a deploy whose CLI never connected be replaced by another", async () => {
    renderSection(withDeploy({ id: "deploy-1", state: "waiting" }));

    expect(screen.queryByRole("button", { name: "Use this relay" })).toBeNull();
    await act(async () => {
      fireEvent.click(button("Guided deploy"));
    });
    expect(openRelayDeployTerminal).toHaveBeenCalledOnce();
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

  it("keeps what the person typed when the deploy's pane asks for the URL field", () => {
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
    fireEvent.change(field, { target: { value: "https://mine.example.workers.dev" } });

    act(() => requestRelayUrl());

    expect(field.value).toBe("https://mine.example.workers.dev");
  });

  it("replaces a URL it filled in for a deploy another deploy has since replaced", () => {
    const first: DecisionsRelayDeploy = {
      id: "deploy-1",
      state: "completed",
      url: DEPLOYED_URL,
      claimState: "unclaimed",
      holdsClaimSecret: true,
    };
    const { rerender } = renderSection(withDeploy(first));
    act(() => requestRelayUrl());
    const field = screen.getByPlaceholderText(
      "https://decisions.example.workers.dev"
    ) as HTMLInputElement;
    expect(field.value).toBe(DEPLOYED_URL);

    const nextUrl = "https://daintree-decisions-9f8e7d6c.me.workers.dev";
    rerender(
      <TooltipProvider>
        <DecisionsConnectionSection
          status={withDeploy({ ...first, id: "deploy-2", url: nextUrl })}
          locked={false}
        />
      </TooltipProvider>
    );
    act(() => requestRelayUrl());

    expect(field.value).toBe(nextUrl);
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

  describe("main's claim of the deployed relay (#16200)", () => {
    const DEPLOYED_ORIGIN = DEPLOYED_URL;
    const COMPLETED: DecisionsRelayDeploy = {
      id: "deploy-1",
      state: "completed",
      url: DEPLOYED_URL,
      claimState: "unclaimed",
      holdsClaimSecret: true,
    };
    const outcomeRow = () => document.getElementById("decisions-deploy-outcome")!;

    it("starts nothing else while main claims the relay, and asks no URL check or secret", () => {
      renderSection(withDeploy({ ...COMPLETED, claim: { state: "claiming" } }));

      expect(outcomeRow().textContent).toMatch(/Claiming the deployed relay/);
      expect(outcomeRow().querySelector("button")).toBeNull();
      expect(button("Guided deploy").disabled).toBe(true);
      expect(
        (screen.getByPlaceholderText("https://decisions.example.workers.dev") as HTMLInputElement)
          .disabled
      ).toBe(true);
      expect(checkRelay).not.toHaveBeenCalled();
      expect(screen.queryByText(/CLAIM_SECRET/)).toBeNull();
    });

    it("shows a claimed relay beside the connection, says when agents get ask_human, and moves on to pairing", () => {
      const devices = document.createElement("section");
      devices.id = "decisions-devices";
      const pair = document.createElement("button");
      pair.setAttribute("data-decisions-pair-phone", "");
      pair.textContent = "Pair a phone";
      devices.append(pair);
      document.body.append(devices);
      try {
        renderSection({
          state: "connected",
          relayOrigin: DEPLOYED_ORIGIN,
          relayDeploy: {
            id: "deploy-1",
            state: "completed",
            url: DEPLOYED_URL,
            claimState: "unclaimed",
            claim: { state: "claimed", origin: DEPLOYED_ORIGIN },
          },
        });

        const row = outcomeRow();
        expect(row.textContent).toMatch(/Relay deployed and claimed/);
        expect(row.textContent).toMatch(/Supported agents launched from now on get ask_human/);
        expect(row.textContent).toMatch(/already running get it at their next launch/);
        expect(screen.queryByRole("group", { name: "Don't have a relay yet?" })).toBeNull();

        fireEvent.click(within(row).getByRole("button", { name: "Pair a phone" }));
        expect(document.activeElement).toBe(pair);
      } finally {
        devices.remove();
      }
    });

    it("shows no claimed outcome for a relay other than the one set up here", () => {
      renderSection({
        state: "connected",
        relayOrigin: "https://other.example.workers.dev",
        relayDeploy: {
          ...COMPLETED,
          holdsClaimSecret: undefined,
          claim: { state: "claimed", origin: DEPLOYED_ORIGIN },
        },
      });

      expect(document.getElementById("decisions-deploy-outcome")).toBeNull();
    });

    it("finishes a claim that didn't confirm with the secret main holds, checking nothing first", async () => {
      const saved: DecisionsStatus = { state: "connecting", relayOrigin: DEPLOYED_ORIGIN };
      claimDeployedRelay.mockResolvedValue({ result: "saved", status: saved });
      const onChanged = vi.fn();
      renderSection(
        withDeploy({
          ...COMPLETED,
          claim: {
            state: "failed",
            failure: {
              result: "unreachable",
              origin: DEPLOYED_ORIGIN,
              reason: "timeout",
              kept: true,
            },
          },
        }),
        undefined,
        false,
        onChanged
      );

      expect(outcomeRow().textContent).toMatch(/didn't confirm the claim/);
      expect(outcomeRow().textContent).toMatch(/holds the deploy's claim secret in memory/);
      expect(screen.queryByRole("button", { name: "Use this relay" })).toBeNull();
      await act(async () => {
        fireEvent.click(button("Finish the claim"));
      });

      expect(claimDeployedRelay).toHaveBeenCalledExactlyOnceWith({ deployId: "deploy-1" });
      expect(checkRelay).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalledWith(saved);
    });

    it("asks before sealing with weaker storage, then claims with it", async () => {
      claimDeployedRelay.mockReturnValue(new Promise(() => {}));
      renderSection(
        withDeploy({
          ...COMPLETED,
          claim: {
            state: "failed",
            failure: {
              result: "key-storage",
              kind: "weak-storage-unconfirmed",
              reason: "No keyring answered",
            },
          },
        })
      );

      expect(outcomeRow().textContent).toMatch(/Only weaker key storage is available/);
      expect(outcomeRow().textContent).toMatch(/fixed key keeps the keys only from someone/);
      await act(async () => {
        fireEvent.click(button("Use weaker storage"));
      });

      expect(claimDeployedRelay).toHaveBeenCalledExactlyOnceWith({
        deployId: "deploy-1",
        acceptWeakStorage: true,
      });
    });

    it("says a refusal main didn't record on the deploy, once", async () => {
      claimDeployedRelay.mockRejectedValue(
        new Error("Daintree no longer holds the claim secret from that deploy")
      );
      const failed: DecisionsRelayDeploy = {
        ...COMPLETED,
        claim: { state: "failed", failure: { result: "error", message: "Decisions is off" } },
      };
      const { rerender } = renderSection(withDeploy(failed));

      await act(async () => {
        fireEvent.click(button("Finish the claim"));
      });
      expect(outcomeRow().textContent).toMatch(/no longer holds the claim secret/);

      // The status read the settled claim asks for brings a copy of the same claim.
      rerender(
        <TooltipProvider>
          <DecisionsConnectionSection status={withDeploy(structuredClone(failed))} locked={false} />
        </TooltipProvider>
      );
      expect(outcomeRow().textContent).toMatch(/no longer holds the claim secret/);

      // Main's own record of a later attempt replaces it.
      rerender(
        <TooltipProvider>
          <DecisionsConnectionSection
            status={withDeploy({
              ...failed,
              claim: { state: "failed", failure: { result: "error", message: "Still off" } },
            })}
            locked={false}
          />
        </TooltipProvider>
      );
      expect(outcomeRow().textContent).not.toMatch(/no longer holds the claim secret/);
      expect(outcomeRow().textContent).toMatch(/Still off\./);
    });

    it("leaves Connection as it was for a cancelled deploy, with its reason", () => {
      renderSection(
        withDeploy({
          ...COMPLETED,
          state: "cancelled",
          error: "Cancelled at the summary",
        })
      );

      expect(outcomeRow().textContent).toMatch(
        /Cancelled at the summary\. It stopped after creating/
      );
      expect(outcomeRow().textContent).toMatch(/Daintree didn't claim it/);
      expect(document.getElementById("decisions-connection-status")!.textContent).toMatch(
        /Not connected/
      );
      expect(button("Use this relay").disabled).toBe(false);
      expect(claimDeployedRelay).not.toHaveBeenCalled();
    });

    it("offers nothing more for a claimed relay this computer has since disconnected from", () => {
      renderSection(
        withDeploy({
          ...COMPLETED,
          holdsClaimSecret: undefined,
          claim: { state: "claimed", origin: DEPLOYED_ORIGIN },
        })
      );

      expect(document.getElementById("decisions-deploy-outcome")).toBeNull();
      expect(screen.queryByRole("button", { name: "Pair a phone" })).toBeNull();
      expect(button("Guided deploy").disabled).toBe(false);
    });

    it("promises no ask_human for a claimed relay that has revoked this computer", () => {
      renderSection({
        state: "revoked",
        relayOrigin: DEPLOYED_ORIGIN,
        relayDeploy: {
          ...COMPLETED,
          holdsClaimSecret: undefined,
          claim: { state: "claimed", origin: DEPLOYED_ORIGIN },
        },
      });

      expect(document.getElementById("decisions-deploy-outcome")).toBeNull();
      expect(screen.queryByText(/get ask_human/)).toBeNull();
    });

    it("says a cancelled deploy's relay is claimed once the person claimed it", () => {
      renderSection({
        state: "connecting",
        relayOrigin: DEPLOYED_ORIGIN,
        relayDeploy: {
          ...COMPLETED,
          state: "cancelled",
          holdsClaimSecret: undefined,
          claim: { state: "claimed", origin: DEPLOYED_ORIGIN },
        },
      });

      expect(outcomeRow().textContent).toMatch(/Relay deployed and claimed/);
      expect(outcomeRow().textContent).not.toMatch(/didn't claim it/);
      expect(within(outcomeRow()).getByRole("button", { name: "Pair a phone" })).toBeTruthy();
    });

    it("announces how main's claim ended", () => {
      const live = () =>
        screen
          .getAllByRole("status")
          .map((region) => region.textContent)
          .join(" | ");
      const { rerender } = renderSection(
        withDeploy({ ...COMPLETED, claim: { state: "claiming" } })
      );
      expect(live()).not.toMatch(/didn't confirm the claim/);

      rerender(
        <TooltipProvider>
          <DecisionsConnectionSection
            status={withDeploy({
              ...COMPLETED,
              claim: {
                state: "failed",
                failure: {
                  result: "unreachable",
                  origin: DEPLOYED_ORIGIN,
                  reason: "timeout",
                  kept: true,
                },
              },
            })}
            locked={false}
          />
        </TooltipProvider>
      );

      expect(live()).toMatch(/didn't confirm the claim\./);
      expect(live()).toMatch(/so the claim can be finished with it/);
    });
  });
});
