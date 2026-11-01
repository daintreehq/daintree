// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ClaimDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsRelayCheck,
  DecisionsRelayCompatibility,
  DecisionsStatus,
  RestoreDecisionsIdentityPayload,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";

// The confirm itself is ConfirmDialog's; here only what the section does with it.
vi.mock("../DecisionsDisconnectDialog", () => ({
  DecisionsDisconnectDialog: (props: {
    isOpen: boolean;
    relayOrigin: string | null;
    error: string | null;
    onCancel: () => void;
    onConfirm: () => void;
  }) =>
    props.isOpen ? (
      <div role="alertdialog" aria-label={props.relayOrigin ?? "unfinished keys"}>
        {props.error && <p role="alert">{props.error}</p>}
        <button onClick={props.onCancel}>Cancel</button>
        <button onClick={props.onConfirm}>Confirm</button>
      </div>
    ) : null,
}));

import { DecisionsConnectionSection } from "../DecisionsConnectionSection";

const ORIGIN = "https://decisions.example.workers.dev";
const SECRET = "claim-secret-0123456789abcdef";
const PASSPHRASE = "correct horse battery staple";

const SAME: DecisionsRelayCompatibility = {
  relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
  daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
  diverges: false,
};

const checkRelay = vi.fn<(url: string) => Promise<DecisionsRelayCheck>>();
const claimRelay =
  vi.fn<(payload: ClaimDecisionsRelayPayload) => Promise<DecisionsConnectResult>>();
const restoreIdentity =
  vi.fn<(payload: RestoreDecisionsIdentityPayload) => Promise<DecisionsConnectResult>>();
const disconnectRelay = vi.fn<() => Promise<DecisionsStatus>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSection(status: DecisionsStatus, onChanged = vi.fn()) {
  const view = render(
    <TooltipProvider>
      <DecisionsConnectionSection status={status} onChanged={onChanged} />
    </TooltipProvider>
  );
  return { view, onChanged };
}

type ClaimState = "unclaimed" | "claimed" | "claim-not-configured";

function relayCheck(result: ClaimState): DecisionsRelayCheck {
  return { result, origin: ORIGIN, compatibility: SAME };
}

async function checkAddress(result: ClaimState, typed = ORIGIN) {
  checkRelay.mockResolvedValue(relayCheck(result));
  const field = screen.getByPlaceholderText(ORIGIN) as HTMLInputElement;
  fireEvent.change(field, { target: { value: typed } });
  await act(async () => {
    fireEvent.submit(field.form!);
  });
}

function secretField(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("#decisions-claim-secret input[type=password]")!;
}

function passphraseField(): HTMLInputElement {
  return document.querySelector('input[aria-label="Recovery kit passphrase"]')!;
}

async function chooseKit(text: string, name = "decisions-recovery.json") {
  const input = screen.getByLabelText("Recovery kit file") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([text], name)] } });
  });
}

async function submit(element: HTMLElement) {
  await act(async () => {
    fireEvent.submit(element.closest("form")!);
  });
}

describe("DecisionsConnectionSection claim and restore", () => {
  beforeEach(() => {
    checkRelay.mockReset();
    claimRelay.mockReset();
    restoreIdentity.mockReset();
    disconnectRelay.mockReset();
    Object.defineProperty(window, "electron", {
      value: { decisions: { checkRelay, claimRelay, restoreIdentity, disconnectRelay } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("offers neither until a check says what the relay is", () => {
    renderSection({ state: "not-connected" });

    expect(document.querySelector("#decisions-claim-secret")).toBeNull();
    expect(document.querySelector("#decisions-recovery-kit")).toBeNull();
  });

  it("claims an unclaimed relay with the secret, clearing the field as the claim starts", async () => {
    const answer = deferred<DecisionsConnectResult>();
    claimRelay.mockReturnValue(answer.promise);
    const { onChanged } = renderSection({ state: "not-connected" });
    await checkAddress("unclaimed", "decisions.example.workers.dev");
    expect(document.querySelector("#decisions-recovery-kit")).toBeNull();

    const claim = screen.getByRole("button", { name: "Claim relay" }) as HTMLButtonElement;
    fireEvent.change(secretField(), { target: { value: SECRET.slice(0, 15) } });
    expect(claim.disabled).toBe(true);
    fireEvent.change(secretField(), { target: { value: SECRET } });
    await submit(secretField());

    expect(claimRelay).toHaveBeenCalledExactlyOnceWith({
      url: "decisions.example.workers.dev",
      claimSecret: SECRET,
    });
    expect(secretField().value).toBe("");

    await act(async () => {
      answer.resolve({ result: "saved", status: { state: "not-connected", relayOrigin: ORIGIN } });
    });
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({
      state: "not-connected",
      relayOrigin: ORIGIN,
    });
  });

  it("says what a refused claim observed, with the secret gone from the field", async () => {
    claimRelay.mockResolvedValue({
      result: "refused",
      origin: ORIGIN,
      reason: "wrong-secret",
      kept: false,
    });
    const { onChanged } = renderSection({ state: "not-connected" });
    await checkAddress("unclaimed");

    fireEvent.change(secretField(), { target: { value: SECRET } });
    await submit(secretField());

    const row = document.querySelector("#decisions-relay-setup-outcome")!;
    expect(row.textContent).toContain("decisions.example.workers.dev refused the claim secret");
    expect(row.textContent).toMatch(/Nothing was saved\.$/);
    expect(secretField().value).toBe("");
    // Main didn't say how the status moved, so the section asks for it again.
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("restores a claimed relay from a chosen kit and passphrase, clearing both as it starts", async () => {
    const answer = deferred<DecisionsConnectResult>();
    restoreIdentity.mockReturnValue(answer.promise);
    renderSection({ state: "not-connected" });
    await checkAddress("claimed");
    expect(document.querySelector("#decisions-claim-secret")).toBeNull();

    const restore = screen.getByRole("button", { name: "Restore identity" }) as HTMLButtonElement;
    await chooseKit('{"v":1}');
    expect(screen.getByText("decisions-recovery.json")).toBeTruthy();
    expect(restore.disabled).toBe(true);
    fireEvent.change(passphraseField(), { target: { value: PASSPHRASE } });
    await submit(passphraseField());

    expect(restoreIdentity).toHaveBeenCalledExactlyOnceWith({
      url: ORIGIN,
      kit: '{"v":1}',
      passphrase: PASSPHRASE,
    });
    expect(passphraseField().value).toBe("");
    expect(screen.getByText("No kit chosen")).toBeTruthy();

    await act(async () => {
      answer.reject(new Error("The relay couldn't be reached"));
    });
    expect(passphraseField().value).toBe("");
    expect(screen.getByText("No kit chosen")).toBeTruthy();
  });

  it("clears the other form's secret too, whichever form is sent", async () => {
    restoreIdentity.mockResolvedValue({
      result: "kit-refused",
      origin: ORIGIN,
      reason: "not-a-kit",
    });
    claimRelay.mockResolvedValue({
      result: "refused",
      origin: ORIGIN,
      reason: "wrong-secret",
      kept: true,
    });
    renderSection({ state: "not-connected", keysStored: true });
    await checkAddress("claimed");

    fireEvent.change(secretField(), { target: { value: SECRET } });
    await chooseKit('{"v":1}');
    fireEvent.change(passphraseField(), { target: { value: PASSPHRASE } });
    await submit(passphraseField());
    expect(secretField().value).toBe("");

    fireEvent.change(secretField(), { target: { value: SECRET } });
    await chooseKit('{"v":1}');
    fireEvent.change(passphraseField(), { target: { value: PASSPHRASE } });
    await submit(secretField());
    expect(passphraseField().value).toBe("");
    expect(screen.getByText("No kit chosen")).toBeTruthy();
  });

  it("keeps only the latest kit chosen, and none that a slower read finishes after a send", async () => {
    const reads = [deferred<string>(), deferred<string>()];
    const files = ["first.json", "second.json"].map((name, index) => {
      const file = new File(["{}"], name);
      Object.defineProperty(file, "text", { value: () => reads[index]!.promise });
      return file;
    });
    restoreIdentity.mockResolvedValue({
      result: "kit-refused",
      origin: ORIGIN,
      reason: "not-a-kit",
    });
    renderSection({ state: "not-connected" });
    await checkAddress("claimed");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;

    await act(async () => {
      fireEvent.change(input, { target: { files: [files[0]] } });
    });
    await act(async () => {
      fireEvent.change(input, { target: { files: [files[1]] } });
    });
    await act(async () => {
      reads[1]!.resolve('{"second":true}');
    });
    fireEvent.change(passphraseField(), { target: { value: PASSPHRASE } });
    await submit(passphraseField());
    await act(async () => {
      reads[0]!.resolve('{"first":true}');
    });

    expect(restoreIdentity).toHaveBeenCalledExactlyOnceWith({
      url: ORIGIN,
      kit: '{"second":true}',
      passphrase: PASSPHRASE,
    });
    expect(screen.getByText("No kit chosen")).toBeTruthy();
  });

  it("offers what the relay is now when a claim finds it claimed since the check", async () => {
    claimRelay.mockResolvedValue({ result: "relay", check: relayCheck("claimed") });
    renderSection({ state: "not-connected" });
    await checkAddress("unclaimed");

    fireEvent.change(secretField(), { target: { value: SECRET } });
    await submit(secretField());

    expect(document.querySelector("#decisions-claim-secret")).toBeNull();
    expect(document.querySelector("#decisions-recovery-kit")).not.toBeNull();
    expect(document.querySelector("#decisions-relay-check")?.textContent).toContain(
      "decisions.example.workers.dev is claimed"
    );
  });

  it("refuses a file too large to be a kit without reading it", async () => {
    const text = vi.spyOn(File.prototype, "text");
    renderSection({ state: "not-connected" });
    await checkAddress("claimed");

    await chooseKit("x".repeat(256 * 1024 + 1));

    expect(text).not.toHaveBeenCalled();
    text.mockRestore();
    expect(screen.getByText("That file is too large to be a recovery kit")).toBeTruthy();
    expect(screen.getByText("No kit chosen")).toBeTruthy();
  });

  it("offers to finish this computer's own claim on a claimed relay while its keys are here", async () => {
    renderSection({ state: "not-connected", keysStored: true });
    await checkAddress("claimed");

    expect(document.querySelector("#decisions-claim-secret")?.textContent).toContain(
      "Finish a claim from this computer"
    );
    expect(document.querySelector("#decisions-recovery-kit")).not.toBeNull();
  });

  it("asks before the weaker storage, then sends the person's acceptance with the next claim", async () => {
    claimRelay.mockResolvedValueOnce({
      result: "key-storage",
      kind: "weak-storage-unconfirmed",
      reason: "No keyring is available",
    });
    claimRelay.mockResolvedValueOnce({
      result: "saved",
      status: { state: "not-connected", relayOrigin: ORIGIN },
    });
    renderSection({ state: "not-connected" });
    await checkAddress("unclaimed");
    fireEvent.change(secretField(), { target: { value: SECRET } });
    await submit(secretField());

    expect(screen.getByText("Only weaker key storage is available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use weaker storage" }));
    fireEvent.change(secretField(), { target: { value: SECRET } });
    await submit(secretField());

    expect(claimRelay.mock.calls.map(([payload]) => payload.acceptWeakStorage)).toEqual([
      undefined,
      true,
    ]);
  });

  it("says a claim main couldn't make on its own row", async () => {
    claimRelay.mockRejectedValue(new Error("Decisions is off, so nothing was changed"));
    renderSection({ state: "not-connected" });
    await checkAddress("unclaimed");

    fireEvent.change(secretField(), { target: { value: SECRET } });
    await submit(secretField());

    const row = document.querySelector("#decisions-relay-setup-outcome")!;
    expect(row.textContent).toContain("Couldn't claim the relay");
    expect(row.textContent).toContain("Decisions is off, so nothing was changed");
  });

  it("forgets the claim's outcome and fields when the address is edited", async () => {
    claimRelay.mockResolvedValue({
      result: "refused",
      origin: ORIGIN,
      reason: "wrong-secret",
      kept: false,
    });
    renderSection({ state: "not-connected" });
    await checkAddress("unclaimed");
    fireEvent.change(secretField(), { target: { value: SECRET } });
    await submit(secretField());

    fireEvent.change(secretField(), { target: { value: SECRET } });

    fireEvent.change(screen.getByPlaceholderText(ORIGIN), { target: { value: "other.example" } });
    expect(document.querySelector("#decisions-relay-setup-outcome")).toBeNull();
    expect(document.querySelector("#decisions-claim-secret")).toBeNull();

    await checkAddress("unclaimed", "other.example");
    expect(secretField().value).toBe("");
  });
});

describe("DecisionsConnectionSection disconnect", () => {
  beforeEach(() => {
    checkRelay.mockReset();
    disconnectRelay.mockReset();
    Object.defineProperty(window, "electron", {
      value: { decisions: { checkRelay, claimRelay, restoreIdentity, disconnectRelay } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("disconnects only after the confirm, and closes it once the identity is gone", async () => {
    disconnectRelay.mockResolvedValue({ state: "not-connected" });
    const { onChanged } = renderSection({ state: "not-connected", relayOrigin: ORIGIN });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect relay" }));
    expect(disconnectRelay).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: ORIGIN })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(disconnectRelay).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({ state: "not-connected" });
  });

  it("keeps the confirm open with the reason when the keys couldn't be removed", async () => {
    disconnectRelay.mockRejectedValue(new Error("The key file couldn't be removed"));
    renderSection({ state: "not-connected", relayOrigin: ORIGIN });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect relay" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The key file couldn't be removed");
  });

  it("does nothing when the confirm is cancelled", () => {
    renderSection({ state: "not-connected", relayOrigin: ORIGIN });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect relay" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(disconnectRelay).not.toHaveBeenCalled();
  });

  it("offers to remove an unfinished setup's keys, and nothing with no keys or relay", () => {
    const { view } = renderSection({ state: "not-connected", keysStored: true });

    fireEvent.click(screen.getByRole("button", { name: "Remove keys" }));
    expect(screen.getByRole("alertdialog", { name: "unfinished keys" })).toBeTruthy();

    view.unmount();
    renderSection({ state: "not-connected" });
    expect(screen.queryByRole("button", { name: "Remove keys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect relay" })).toBeNull();
  });
});
