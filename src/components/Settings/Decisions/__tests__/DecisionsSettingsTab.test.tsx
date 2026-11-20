// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  ClaimDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsDevicesResult,
  DecisionsKitVerifyResult,
  DecisionsPolicy,
  DecisionsRelayCheck,
  DecisionsStatus,
  VerifyDecisionsRecoveryKitPayload,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { _resetHostPlatformForTests } from "@/hooks/useHostPlatform";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { DecisionsSettingsTab } from "../DecisionsSettingsTab";

const remote = vi.hoisted(() => ({ hostName: null as string | null }));
vi.mock("@/hooks/useSettingsOwner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useSettingsOwner")>()),
  useRemoteHostName: () => remote.hostName,
}));

const ORIGIN = "https://decisions.example.workers.dev";
const SECRET = "claim-secret-0123456789abcdef";

const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
const setEnabled = vi.fn<(payload: { enabled: boolean }) => Promise<DecisionsStatus>>();
const checkRelay = vi.fn<(url: string) => Promise<DecisionsRelayCheck>>();
const claimRelay =
  vi.fn<(payload: ClaimDecisionsRelayPayload) => Promise<DecisionsConnectResult>>();
/** Every push listener by event name; several sections listen for the status. */
const pushListeners = new Map<string, Set<(payload: unknown) => void>>();
/** Pushes a status to everything listening, as main's `decisions:status-changed` does. */
function pushStatus(status: DecisionsStatus): void {
  for (const listener of pushListeners.get("decisions:status-changed") ?? []) listener(status);
}
const verifyRecoveryKit =
  vi.fn<(payload: VerifyDecisionsRecoveryKitPayload) => Promise<DecisionsKitVerifyResult>>();
const listDevices = vi.fn<() => Promise<DecisionsDevicesResult>>();

function kitPassphraseField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    "#decisions-recovery-kit-save input[type=password]"
  );
}

async function renderTab(onClose?: SettingsTabClose) {
  render(
    <TooltipProvider>
      <DecisionsSettingsTab onClose={onClose} />
    </TooltipProvider>
  );
  await act(async () => {});
}

describe("DecisionsSettingsTab", () => {
  beforeEach(() => {
    remote.hostName = null;
    getStatus.mockReset();
    setEnabled.mockReset();
    checkRelay.mockReset();
    claimRelay.mockReset();
    verifyRecoveryKit.mockReset();
    listDevices.mockReset();
    listDevices.mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, "electron", {
      value: {
        decisions: {
          getStatus,
          setEnabled,
          checkRelay,
          claimRelay,
          verifyRecoveryKit,
          listDevices,
          // The Remote Hosts, Policy, decision model, setup check, Questions and question list reads, which these tests leave unanswered.
          listQuestions: () => new Promise(() => {}),
          listHosts: () => new Promise(() => {}),
          getPolicy: () => new Promise(() => {}),
          getModel: () => new Promise(() => {}),
          getSetupCheck: () => new Promise(() => {}),
          listAttention: () => new Promise(() => {}),
        },
        events: {
          on: (name: string, listener: (payload: unknown) => void) => {
            const listeners = pushListeners.get(name) ?? new Set();
            listeners.add(listener);
            pushListeners.set(name, listeners);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("keeps the agreement open and locked until main answers, then hands focus back to the switch", async () => {
    getStatus.mockResolvedValue({ state: "off" });
    let answer!: (status: DecisionsStatus) => void;
    setEnabled.mockReturnValue(
      new Promise<DecisionsStatus>((resolve) => {
        answer = resolve;
      })
    );
    await renderTab();
    const enable = () =>
      screen.getByRole("switch", { name: "Enable Decisions" }) as HTMLButtonElement;

    enable().focus();
    fireEvent.click(enable());
    const accept = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Turn on Decisions",
    });
    act(() => accept.focus());
    await act(async () => {
      fireEvent.click(accept);
    });
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith({ enabled: true, consent: true });
    // Past any exit animation, still open over a switch that can't take focus
    // yet, and Cancel can't take back what's being saved.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(enable().disabled).toBe(true);

    await act(async () => answer({ state: "not-connected", consentedAt: 1, revision: 1 }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(enable().disabled).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(enable()));
  });

  it("closes the agreement on a failed turn on too, saying why", async () => {
    getStatus.mockResolvedValue({ state: "off" });
    let refuse!: (reason: unknown) => void;
    setEnabled.mockReturnValue(
      new Promise<DecisionsStatus>((_, reject) => {
        refuse = reject;
      })
    );
    await renderTab();
    const enable = () =>
      screen.getByRole("switch", { name: "Enable Decisions" }) as HTMLButtonElement;

    enable().focus();
    fireEvent.click(enable());
    const accept = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Turn on Decisions",
    });
    act(() => accept.focus());
    await act(async () => {
      fireEvent.click(accept);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    await act(async () => refuse(new Error("The key store couldn't be opened")));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("The key store couldn't be opened");
    expect(enable().getAttribute("aria-checked")).toBe("false");
    await vi.waitFor(() => expect(document.activeElement).toBe(enable()));
  });

  it("asks for the kit's passphrase as soon as a claim records the relay", async () => {
    getStatus.mockResolvedValue({ state: "not-connected", consentedAt: 1 });
    checkRelay.mockResolvedValue({
      result: "unclaimed",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
        daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
        diverges: false,
      },
    });
    claimRelay.mockResolvedValue({
      result: "saved",
      status: { state: "not-connected", consentedAt: 1, relayOrigin: ORIGIN, keysStored: true },
    });
    await renderTab();
    expect(kitPassphraseField()).toBeNull();

    const url = screen.getByPlaceholderText(ORIGIN) as HTMLInputElement;
    fireEvent.change(url, { target: { value: ORIGIN } });
    await act(async () => {
      fireEvent.submit(url.form!);
    });
    const secret = document.querySelector<HTMLInputElement>(
      "#decisions-claim-secret input[type=password]"
    )!;
    fireEvent.change(secret, { target: { value: SECRET } });
    await act(async () => {
      fireEvent.submit(secret.form!);
    });

    expect(screen.getByText("Setup isn't finished")).toBeTruthy();
    expect(document.activeElement).toBe(kitPassphraseField());

    // The request was met: turning off and on again later doesn't pull focus back.
    kitPassphraseField()!.blur();
    setEnabled.mockResolvedValueOnce({ state: "off", consentedAt: 1 }).mockResolvedValueOnce({
      state: "not-connected",
      consentedAt: 1,
      relayOrigin: ORIGIN,
      keysStored: true,
    });
    for (let turn = 0; turn < 2; turn += 1) {
      await act(async () => {
        fireEvent.click(screen.getByRole("switch", { name: "Enable Decisions" }));
      });
    }
    expect(setEnabled).toHaveBeenCalledTimes(2);
    expect(kitPassphraseField()).not.toBeNull();
    expect(document.activeElement).not.toBe(kitPassphraseField());
  });

  it("moves on to pairing a phone, not the kit, when a guided deploy's claim records the relay (#16200)", async () => {
    const deploy = {
      id: "deploy-1",
      state: "completed",
      url: ORIGIN,
      claimState: "unclaimed",
      holdsClaimSecret: true,
      claim: { state: "claiming" },
    } as const;
    getStatus.mockResolvedValue({ state: "not-connected", consentedAt: 1, relayDeploy: deploy });
    Object.assign(window.electron.decisions, {
      listDevices: async () => ({ result: "listed", devices: [] }),
    });
    await renderTab();

    await act(async () => {
      pushStatus({
        state: "not-connected",
        consentedAt: 1,
        relayOrigin: ORIGIN,
        keysStored: true,
        relayDeploy: deploy,
      });
    });

    expect(screen.getByText("Setup isn't finished")).toBeTruthy();
    expect(document.activeElement).not.toBe(kitPassphraseField());
    expect(document.activeElement).toBe(
      document.querySelector("#decisions-devices [data-decisions-pair-phone]")
    );
  });

  it("asks for the kit's passphrase even when a status push shows the relay before the claim answers", async () => {
    getStatus.mockResolvedValue({ state: "not-connected", consentedAt: 1, revision: 1 });
    checkRelay.mockResolvedValue({
      result: "unclaimed",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
        daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
        diverges: false,
      },
    });
    let answer!: (result: DecisionsConnectResult) => void;
    claimRelay.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderTab();

    const url = screen.getByPlaceholderText(ORIGIN) as HTMLInputElement;
    fireEvent.change(url, { target: { value: ORIGIN } });
    await act(async () => {
      fireEvent.submit(url.form!);
    });
    const secret = document.querySelector<HTMLInputElement>(
      "#decisions-claim-secret input[type=password]"
    )!;
    fireEvent.change(secret, { target: { value: SECRET } });
    await act(async () => {
      fireEvent.submit(secret.form!);
    });
    const saved = { state: "connecting" as const, consentedAt: 1, relayOrigin: ORIGIN };
    // The connection's first push, newer than the answer the claim is about to give.
    await act(async () => pushStatus({ ...saved, revision: 3 }));
    expect(screen.getByText("Setup isn't finished")).toBeTruthy();
    await act(async () => answer({ result: "saved", status: { ...saved, revision: 2 } }));

    expect(document.activeElement).toBe(kitPassphraseField());
  });

  it("asks for nothing when the relay first shows while off, nor on turning on again", async () => {
    getStatus.mockResolvedValue({ state: "not-connected", consentedAt: 1, revision: 1 });
    await renderTab();

    await act(async () => pushStatus({ state: "off", relayOrigin: ORIGIN, revision: 2 }));
    const on = { state: "not-connected" as const, relayOrigin: ORIGIN, keysStored: true as const };
    await act(async () => pushStatus({ ...on, revision: 3 }));

    expect(kitPassphraseField()).not.toBeNull();
    expect(document.activeElement).not.toBe(kitPassphraseField());
  });

  it("keeps the kit in Data once verified, with the setup check left to finish setup", async () => {
    getStatus.mockResolvedValue({
      state: "not-connected",
      consentedAt: 1,
      relayOrigin: ORIGIN,
      keysStored: true,
    });
    verifyRecoveryKit.mockResolvedValue({
      result: "verified",
      status: {
        state: "not-connected",
        consentedAt: 1,
        relayOrigin: ORIGIN,
        keysStored: true,
        recoveryKitVerifiedAt: 7,
        recoveryKitCurrent: true,
      },
    });
    await renderTab();
    expect(screen.getByText("Setup isn't finished")).toBeTruthy();
    // Opening Settings on an unfinished setup doesn't pull focus by itself.
    expect(document.activeElement).not.toBe(kitPassphraseField());

    fireEvent.click(screen.getByRole("button", { name: "Save recovery kit" }));
    expect(document.activeElement).toBe(kitPassphraseField());

    const input = screen.getByLabelText("Recovery kit file to verify") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['{"v":1}'], "kit.json")] } });
    });
    const passphrase = screen.getByLabelText("Passphrase of the kit to verify") as HTMLInputElement;
    fireEvent.change(passphrase, { target: { value: "correct horse battery staple" } });
    await act(async () => {
      fireEvent.submit(passphrase.form!);
    });

    // The kit's warning goes; the setup check's takes its place (#16024).
    expect(screen.queryByRole("button", { name: "Save recovery kit" })).toBeNull();
    expect(screen.getByText(/Run the setup check to finish/)).toBeTruthy();
    expect(document.getElementById("decisions-recovery-kit-status")?.textContent ?? "").toContain(
      "Recovery kit verified"
    );
    expect(screen.getByText("Kit checked")).toBeTruthy();
    expect(kitPassphraseField()).not.toBeNull();
  });

  it("shows Agents whether launches get ask_human as main pushes the connection (#16203)", async () => {
    getStatus.mockResolvedValue({ state: "not-connected", consentedAt: 1, revision: 1 });
    // Connection checks a relay once one is set up; this test leaves it unanswered.
    checkRelay.mockReturnValue(new Promise(() => {}));
    await renderTab();
    const notice = () =>
      document.querySelector("#decisions-agents [data-testid='decisions-agents-not-connected']");
    expect(notice()?.textContent).toMatch(/No relay is connected/);

    act(() => pushStatus({ state: "connected", consentedAt: 1, relayOrigin: ORIGIN, revision: 2 }));
    expect(notice()).toBeNull();

    act(() =>
      pushStatus({
        state: "not-connected",
        consentedAt: 1,
        relayOrigin: ORIGIN,
        problem: "keys",
        revision: 3,
      })
    );
    expect(notice()?.textContent).toMatch(/The relay isn't connected/);
  });

  it("says under the connected status what it saw of the rest of Decisions, from the one read of the devices (#18059)", async () => {
    getStatus.mockResolvedValue({ state: "connected", consentedAt: 1, relayOrigin: ORIGIN });
    checkRelay.mockReturnValue(new Promise(() => {}));
    listDevices.mockResolvedValue({
      result: "listed",
      devices: [
        {
          deviceId: "dev_pixel",
          label: "Pixel 9",
          role: "phone",
          pairedAt: "2026-10-30T00:00:00.000Z",
          lastSeenAt: null,
          pushEnabled: true,
        },
      ],
    });
    await renderTab();

    const status = document.getElementById("decisions-connection-status")!;
    expect(status.textContent).toContain("Connected to decisions.example.workers.dev");
    expect(within(status).getByTestId("decisions-status-facts").textContent).toBe(
      "1 phone with notifications · Reading agents… · Reading questions…"
    );
    // Devices lists the same read rather than asking the relay again.
    expect(await screen.findByText("Pixel 9")).toBeTruthy();
    expect(listDevices).toHaveBeenCalledOnce();
  });

  it("never shows one relay's phones for another, and reads none while off (#18059)", async () => {
    getStatus.mockResolvedValue({
      state: "connected",
      consentedAt: 1,
      relayOrigin: ORIGIN,
      revision: 1,
    });
    checkRelay.mockReturnValue(new Promise(() => {}));
    listDevices
      .mockResolvedValueOnce({
        result: "listed",
        devices: [
          {
            deviceId: "dev_pixel",
            label: "Pixel 9",
            role: "phone",
            pairedAt: "2026-10-30T00:00:00.000Z",
            lastSeenAt: null,
            pushEnabled: true,
          },
        ],
      })
      .mockReturnValueOnce(new Promise(() => {}));
    await renderTab();
    const facts = () => screen.getByTestId("decisions-status-facts").textContent ?? "";
    expect(facts()).toMatch(/^1 phone with notifications · /);

    await act(async () =>
      pushStatus({
        state: "connected",
        consentedAt: 1,
        relayOrigin: "https://other.example.workers.dev",
        revision: 2,
      })
    );
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(facts()).toMatch(/^Reading phones… · /);
    expect(screen.queryByText("Pixel 9")).toBeNull();

    // Off keeps the relay recorded, but nothing is shown that would read its devices.
    await act(async () =>
      pushStatus({ state: "off", consentedAt: 1, relayOrigin: ORIGIN, revision: 3 })
    );
    expect(listDevices).toHaveBeenCalledTimes(2);
  });

  describe("no agent switched on (#18057)", () => {
    const FINISHED: DecisionsStatus = {
      state: "connected",
      consentedAt: 1,
      relayOrigin: ORIGIN,
      recoveryKitVerifiedAt: 1,
      setupCheck: { checkedAt: 2, failedStep: null },
    };
    function policy(askHumanAgents: string[], revision: number): DecisionsPolicy {
      return {
        gates: [],
        defaultQuestionExpiryMs: null,
        maxQuestionExpiryMs: null,
        askHumanAgents,
        revision,
      };
    }
    /** Each policy read main is asked for, answered by the test. */
    let reads: Array<{ resolve: (p: DecisionsPolicy) => void; reject: (e: unknown) => void }>;
    const agentsOffWarning = () => screen.queryByText(/No agents are switched on/);
    const probed = useCliAvailabilityStore.getState();

    beforeEach(() => {
      useCliAvailabilityStore.setState({
        availability: { claude: "ready" },
        hasRealData: true,
        error: null,
      });
      reads = [];
      window.electron.decisions.getPolicy = () =>
        new Promise<DecisionsPolicy>((resolve, reject) => reads.push({ resolve, reject }));
      getStatus.mockResolvedValue(FINISHED);
      checkRelay.mockReturnValue(new Promise(() => {}));
    });
    afterEach(() => {
      delete window.__DAINTREE_HOST_ID__;
      _resetHostPlatformForTests();
      useCliAvailabilityStore.setState({
        availability: probed.availability,
        hasRealData: probed.hasRealData,
        error: probed.error,
      });
    });

    it("says so only once main has answered, and follows what it answers next", async () => {
      await renderTab();
      // Unread is never taken for none.
      expect(agentsOffWarning()).toBeNull();
      expect(screen.queryByText("Setup isn't finished")).toBeNull();

      await act(async () => reads.at(-1)!.resolve(policy([], 1)));
      expect(screen.getByText("Setup isn't finished")).toBeTruthy();
      expect(agentsOffWarning()).toBeTruthy();

      // Another window switches one on; main pushes the status and the policy is read again.
      act(() => pushStatus({ ...FINISHED, revision: 2 }));
      await act(async () => reads.at(-1)!.resolve(policy(["claude"], 2)));
      expect(agentsOffWarning()).toBeNull();
      expect(screen.queryByText("Setup isn't finished")).toBeNull();

      act(() => pushStatus({ ...FINISHED, revision: 3 }));
      await act(async () => reads.at(-1)!.resolve(policy([], 3)));
      expect(agentsOffWarning()).toBeTruthy();
    });

    it("keeps saying what the last read answered when a refresh fails, as the switches and facts line do", async () => {
      await renderTab();
      await act(async () => reads.at(-1)!.resolve(policy([], 1)));
      expect(agentsOffWarning()).toBeTruthy();

      act(() => pushStatus({ ...FINISHED, revision: 2 }));
      await act(async () => reads.at(-1)!.reject(new Error("bridge closed")));
      expect(agentsOffWarning()).toBeTruthy();
      expect(screen.getByTestId("decisions-status-facts").textContent).toContain(
        "No agents switched on"
      );
    });

    it("tells none at once from an empty policy, and waits for the CLI probe to count a listed one (#18059)", async () => {
      useCliAvailabilityStore.setState({ hasRealData: false });
      await renderTab();
      await act(async () => reads.at(-1)!.resolve(policy([], 1)));
      expect(agentsOffWarning()).toBeTruthy();
      cleanup();

      await renderTab();
      // Codex is switched on but not installed: no launch of it can ask.
      await act(async () => reads.at(-1)!.resolve(policy(["codex"], 1)));
      expect(agentsOffWarning()).toBeNull();

      act(() => useCliAvailabilityStore.setState({ hasRealData: true }));
      expect(agentsOffWarning()).toBeTruthy();
      expect(screen.getByTestId("decisions-status-facts").textContent).toContain(
        "No agents switched on"
      );
    });

    it("never says so in a remote window, whose agents are the Host's", async () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio" };
      _resetHostPlatformForTests();
      await renderTab();
      await act(async () => reads.at(-1)!.resolve(policy([], 1)));
      expect(agentsOffWarning()).toBeNull();
      expect(screen.queryByRole("button", { name: "Choose agents" })).toBeNull();
    });
  });

  it("groups the phone and desktop notification settings apart from Questions, from Connection's check and Devices' read (#18061)", async () => {
    getStatus.mockResolvedValue({
      state: "connected",
      consentedAt: 1,
      relayOrigin: ORIGIN,
      agentStoppedPushes: true,
      desktopNotifications: false,
      revision: 1,
    });
    const versions = { protocolMin: 1, protocolMax: 1, workerVersion: "0.4.0" };
    checkRelay.mockResolvedValue({
      result: "claimed",
      origin: ORIGIN,
      compatibility: { relay: versions, daintree: versions, diverges: false },
      advertisesAgentStoppedPushes: false,
    });
    listDevices.mockResolvedValue({
      result: "listed",
      devices: [
        {
          deviceId: "dev_pixel",
          label: "Pixel 9",
          role: "phone",
          pairedAt: "2026-10-30T00:00:00.000Z",
          lastSeenAt: null,
          pushEnabled: false,
        },
      ],
    });
    await renderTab();
    await screen.findByText("Pixel 9");

    const notifications = document.getElementById("decisions-notifications")!;
    const questions = document.getElementById("decisions-questions")!;
    const holdSwitch = () =>
      within(notifications).getByRole("switch", {
        name: /Hold phone notifications/,
      }) as HTMLButtonElement;
    const stopped = within(notifications).getByRole("switch", {
      name: /Notify my phone when an agent stops/,
    });
    expect(
      within(questions).queryByRole("switch", { name: /Hold phone notifications/ })
    ).toBeNull();
    expect(
      within(questions).queryByRole("switch", { name: /Notify my phone when an agent stops/ })
    ).toBeNull();
    expect(
      within(notifications).getByRole("button", { name: "Open notification settings" })
    ).toBeTruthy();
    expect(holdSwitch().disabled).toBe(true);
    // One read of the devices and one check of the relay, shared with Devices and Connection.
    expect(listDevices).toHaveBeenCalledOnce();
    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    const described = (stopped.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain(
      "Your relay lists no paired phone or tablet with notifications turned on"
    );
    expect(described).toContain("Your relay didn't advertise support for them");

    act(() =>
      pushStatus({
        state: "connected",
        consentedAt: 1,
        relayOrigin: ORIGIN,
        agentStoppedPushes: true,
        revision: 2,
      })
    );
    expect(holdSwitch().disabled).toBe(false);
  });

  it("says once, in a remote window, that these settings are this computer's and what the Host runs under (#18066)", async () => {
    remote.hostName = "build-box";
    getStatus.mockResolvedValue({ state: "connected", consentedAt: 1, relayOrigin: ORIGIN });
    checkRelay.mockReturnValue(new Promise(() => {}));
    await renderTab();

    const notes = screen.getAllByTestId("decisions-remote-window-note");
    expect(notes).toHaveLength(1);
    const note = notes[0]!.textContent ?? "";
    expect(note).toMatch(/^These settings are saved on this (Mac|PC|machine)\./);
    expect(note).toContain("On build-box, once it's enrolled, every agent that supports ask_human");
    expect(note).toContain("a question waits 7 days unless its agent sets a time");
    expect(note).toContain("from a local window");
    // The note is why Agents is missing here, and Questions' default stays this computer's.
    expect(document.getElementById("decisions-agents")).toBeNull();
    expect(document.getElementById("decisions-questions-expiry")?.textContent).toContain(
      "on this computer"
    );
    expect(document.getElementById("decisions-questions")?.textContent).not.toContain(
      "Remote Host"
    );
  });

  it("says nothing of a Host in a local window, or while Decisions is off (#18066)", async () => {
    getStatus.mockResolvedValue({ state: "connected", consentedAt: 1, relayOrigin: ORIGIN });
    checkRelay.mockReturnValue(new Promise(() => {}));
    await renderTab();
    expect(screen.queryByTestId("decisions-remote-window-note")).toBeNull();
    expect(document.getElementById("decisions-agents")).not.toBeNull();
    cleanup();

    remote.hostName = "build-box";
    getStatus.mockResolvedValue({ state: "off" });
    await renderTab();
    expect(screen.queryByTestId("decisions-remote-window-note")).toBeNull();
  });

  it("closes Settings before it opens the inbox (#17231)", async () => {
    getStatus.mockResolvedValue({ state: "connected", consentedAt: 1, relayOrigin: ORIGIN });
    checkRelay.mockReturnValue(new Promise(() => {}));
    const afterCloses: Array<(closed: boolean) => void> = [];
    const onClose = vi.fn<SettingsTabClose>(async (afterClose) => {
      if (afterClose) afterCloses.push(afterClose);
      return true;
    });
    useDecisionsInboxStore.setState({ isOpen: false });
    await renderTab(onClose);
    fireEvent.click(await screen.findByTestId("decisions-inbox-open"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
    act(() => afterCloses[0]!(true));
    expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
    useDecisionsInboxStore.setState({ isOpen: false });
  });
});
