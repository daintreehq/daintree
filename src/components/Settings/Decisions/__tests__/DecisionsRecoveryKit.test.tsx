// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  DecisionsKitExportResult,
  DecisionsKitVerifyResult,
  DecisionsStatus,
  ExportDecisionsRecoveryKitPayload,
  VerifyDecisionsRecoveryKitPayload,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SettingsDeepLinkProvider,
  type SettingsDeepLink,
} from "@/components/Settings/settingsDeepLink";
import { DecisionsRecoveryKit } from "../DecisionsRecoveryKit";

const ORIGIN = "https://decisions.example.workers.dev";
const PASSPHRASE = "correct horse battery staple";
const UNFINISHED: DecisionsStatus = {
  state: "not-connected",
  relayOrigin: ORIGIN,
  keysStored: true,
};
const VERIFIED_AT = Date.UTC(2026, 10, 1, 12);

const exportRecoveryKit =
  vi.fn<(payload: ExportDecisionsRecoveryKitPayload) => Promise<DecisionsKitExportResult>>();
const verifyRecoveryKit =
  vi.fn<(payload: VerifyDecisionsRecoveryKitPayload) => Promise<DecisionsKitVerifyResult>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderKit(props: Partial<React.ComponentProps<typeof DecisionsRecoveryKit>> = {}): {
  onVerified: ReturnType<typeof vi.fn>;
  rerender: (focusRequest: number) => void;
} {
  const onVerified = vi.fn();
  const view = render(
    <TooltipProvider>
      <DecisionsRecoveryKit
        status={UNFINISHED}
        disabled={false}
        onVerified={onVerified}
        focusRequest={0}
        {...props}
      />
    </TooltipProvider>
  );
  return {
    onVerified,
    rerender: (focusRequest) =>
      view.rerender(
        <TooltipProvider>
          <DecisionsRecoveryKit
            status={UNFINISHED}
            disabled={false}
            onVerified={onVerified}
            focusRequest={focusRequest}
            {...props}
          />
        </TooltipProvider>
      ),
  };
}

function saveField(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    "#decisions-recovery-kit-save input[type=password]"
  )!;
}

function verifyField(): HTMLInputElement {
  return screen.getByLabelText("Passphrase of the kit to verify") as HTMLInputElement;
}

async function chooseKit(text: string, name = "decisions-recovery-kit.json") {
  const input = screen.getByLabelText("Recovery kit file to verify") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([text], name)] } });
  });
}

async function submit(element: HTMLElement) {
  await act(async () => {
    fireEvent.submit(element.closest("form")!);
  });
}

describe("DecisionsRecoveryKit", () => {
  beforeEach(() => {
    exportRecoveryKit.mockReset();
    verifyRecoveryKit.mockReset();
    Object.defineProperty(window, "electron", {
      value: { decisions: { exportRecoveryKit, verifyRecoveryKit } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
    // File.prototype spies, restored even when a test fails part-way.
    vi.restoreAllMocks();
  });

  it("says no kit is verified yet, and when one was", () => {
    renderKit();
    expect(screen.getByText("No recovery kit verified")).toBeTruthy();
    cleanup();

    renderKit({
      status: { ...UNFINISHED, recoveryKitVerifiedAt: VERIFIED_AT, recoveryKitCurrent: true },
    });
    expect(screen.getByText("Recovery kit verified")).toBeTruthy();
    expect(document.querySelector("#decisions-recovery-kit-status")?.textContent ?? "").toContain(
      new Date(VERIFIED_AT).getFullYear().toString()
    );
  });

  it("says a verified kit may be out of date once the keys it was checked against changed (#18064)", () => {
    renderKit({ status: { ...UNFINISHED, recoveryKitVerifiedAt: VERIFIED_AT } });

    const row = document.querySelector("#decisions-recovery-kit-status")?.textContent ?? "";
    expect(screen.getByText("Recovery kit may be out of date")).toBeTruthy();
    expect(screen.queryByText("Recovery kit verified")).toBeNull();
    expect(row).toContain(new Date(VERIFIED_AT).getFullYear().toString());
    expect(row).toContain("save a new kit and verify it");
  });

  it("saves only with a passphrase of at least 12 characters, clearing it as the save starts", async () => {
    const pending = deferred<DecisionsKitExportResult>();
    exportRecoveryKit.mockReturnValue(pending.promise);
    renderKit();
    const button = screen.getByRole("button", { name: "Save kit…" }) as HTMLButtonElement;

    fireEvent.change(saveField(), { target: { value: "x".repeat(11) } });
    expect(button.disabled).toBe(true);
    await submit(saveField());
    expect(exportRecoveryKit).not.toHaveBeenCalled();

    const twelve = "x".repeat(12);
    fireEvent.change(saveField(), { target: { value: twelve } });
    expect(button.disabled).toBe(false);
    await submit(saveField());

    expect(exportRecoveryKit).toHaveBeenCalledExactlyOnceWith({ passphrase: twelve });
    expect(saveField().value).toBe("");
    await act(async () => {
      pending.resolve({ result: "saved", fileName: "decisions-recovery-kit.json" });
    });
    expect(screen.getByText("Saved decisions-recovery-kit.json")).toBeTruthy();
  });

  it("shows nothing for a cancelled dialog, and says why a kit couldn't be made", async () => {
    renderKit();
    exportRecoveryKit.mockResolvedValueOnce({ result: "cancelled" });
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());
    expect(document.querySelector("#decisions-recovery-kit-outcome")).toBeNull();

    exportRecoveryKit.mockResolvedValueOnce({
      result: "key-storage",
      kind: "locked",
      reason: "Unlock the keychain and try again",
    });
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());
    expect(document.querySelector("#decisions-recovery-kit-outcome")?.textContent ?? "").toContain(
      "Unlock the keychain and try again"
    );
  });

  it("says when main couldn't write the kit", async () => {
    exportRecoveryKit.mockRejectedValue(
      new Error("The recovery kit couldn't be saved to kit.json")
    );
    renderKit();

    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());

    const outcome = document.querySelector("#decisions-recovery-kit-outcome")?.textContent ?? "";
    expect(outcome).toContain("Couldn't save the recovery kit");
    expect(outcome).toContain("kit.json");
  });

  it("verifies the chosen file with its passphrase, clearing both, and hands on main's status", async () => {
    const status: DecisionsStatus = { ...UNFINISHED, recoveryKitVerifiedAt: VERIFIED_AT };
    verifyRecoveryKit.mockResolvedValue({ result: "verified", status });
    const { onVerified } = renderKit();
    const button = screen.getByRole("button", { name: "Verify kit" }) as HTMLButtonElement;

    fireEvent.change(verifyField(), { target: { value: PASSPHRASE } });
    expect(button.disabled).toBe(true);
    await chooseKit('{"v":1}');
    expect(screen.getByText("decisions-recovery-kit.json")).toBeTruthy();
    await submit(verifyField());

    expect(verifyRecoveryKit).toHaveBeenCalledExactlyOnceWith({
      kit: '{"v":1}',
      passphrase: PASSPHRASE,
    });
    expect(verifyField().value).toBe("");
    expect(screen.getByText("No kit chosen")).toBeTruthy();
    expect(onVerified).toHaveBeenCalledExactlyOnceWith(status);
  });

  it("says why a kit didn't verify, and records nothing", async () => {
    verifyRecoveryKit.mockResolvedValue({ result: "kit-refused", reason: "missing-epochs" });
    const { onVerified } = renderKit();

    await chooseKit('{"v":1}');
    fireEvent.change(verifyField(), { target: { value: PASSPHRASE } });
    await submit(verifyField());

    expect(document.querySelector("#decisions-recovery-kit-outcome")?.textContent ?? "").toContain(
      "out of date"
    );
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("clears the other form's passphrase too when either is sent", async () => {
    exportRecoveryKit.mockResolvedValue({ result: "cancelled" });
    renderKit();

    fireEvent.change(verifyField(), { target: { value: "typed for the check" } });
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());

    expect(verifyField().value).toBe("");
  });

  it("clears every secret as a verification starts, before main answers", async () => {
    const pending = deferred<DecisionsKitVerifyResult>();
    verifyRecoveryKit.mockReturnValue(pending.promise);
    renderKit();

    fireEvent.change(saveField(), { target: { value: "typed for a save" } });
    await chooseKit('{"v":1}');
    fireEvent.change(verifyField(), { target: { value: PASSPHRASE } });
    await submit(verifyField());

    expect(saveField().value).toBe("");
    expect(verifyField().value).toBe("");
    expect(screen.getByText("No kit chosen")).toBeTruthy();
    await act(async () => {
      pending.resolve({ result: "kit-refused", reason: "wrong-passphrase" });
    });
  });

  it("drops a kit file still being read when a request starts, or when another is chosen", async () => {
    exportRecoveryKit.mockResolvedValue({ result: "cancelled" });
    const reads: Array<ReturnType<typeof deferred<string>>> = [];
    const text = vi.spyOn(File.prototype, "text").mockImplementation(() => {
      const read = deferred<string>();
      reads.push(read);
      return read.promise;
    });
    renderKit();

    await chooseKit('{"v":1}', "slow.json");
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());
    await act(async () => reads[0]!.resolve('{"v":1}'));
    expect(screen.getByText("No kit chosen")).toBeTruthy();

    await chooseKit('{"v":1}', "first.json");
    await chooseKit('{"v":1}', "second.json");
    await act(async () => reads[2]!.resolve('{"v":2}'));
    await act(async () => reads[1]!.resolve('{"v":1}'));
    expect(screen.getByText("second.json")).toBeTruthy();
    expect(screen.queryByText("first.json")).toBeNull();
    text.mockRestore();
  });

  it("says a file error even after an earlier save's outcome", async () => {
    exportRecoveryKit.mockResolvedValue({ result: "saved", fileName: "kit.json" });
    renderKit();
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());
    expect(screen.getByText("Saved kit.json")).toBeTruthy();

    await chooseKit("x".repeat(256 * 1024 + 1));

    expect(
      Array.from(document.querySelectorAll('[role="status"]')).some((region) =>
        region.textContent?.includes("too large to be a recovery kit")
      )
    ).toBe(true);
  });

  it("refuses a file too large to be a kit without reading it, and says so", async () => {
    const text = vi.spyOn(File.prototype, "text");
    renderKit();

    await chooseKit("x".repeat(256 * 1024 + 1));

    expect(text).not.toHaveBeenCalled();
    expect(document.getElementById("decisions-recovery-kit-verify")?.textContent ?? "").toContain(
      "That file is too large to be a recovery kit"
    );
    expect(screen.getByText("No kit chosen")).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll('[role="status"]')).some((region) =>
        region.textContent?.includes("too large to be a recovery kit")
      )
    ).toBe(true);
    text.mockRestore();
  });

  it("takes focus for a request from setup, once", () => {
    const onFocused = vi.fn();
    const { rerender } = renderKit({ onFocused });
    expect(document.activeElement).not.toBe(saveField());

    rerender(1);

    expect(document.activeElement).toBe(saveField());
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("takes focus on mount when setup asked before it rendered", () => {
    renderKit({ focusRequest: 1 });

    expect(document.activeElement).toBe(saveField());
  });

  it("holds a request made while the form is disabled until it can take focus", () => {
    const onFocused = vi.fn();
    const props = { status: UNFINISHED, onVerified: vi.fn(), focusRequest: 1, onFocused };
    const view = render(
      <TooltipProvider>
        <DecisionsRecoveryKit {...props} disabled />
      </TooltipProvider>
    );
    expect(document.activeElement).not.toBe(saveField());
    expect(onFocused).not.toHaveBeenCalled();

    view.rerender(
      <TooltipProvider>
        <DecisionsRecoveryKit {...props} disabled={false} />
      </TooltipProvider>
    );

    expect(document.activeElement).toBe(saveField());
    expect(onFocused).toHaveBeenCalledOnce();
  });
});

describe("DecisionsRecoveryKit once a kit is verified", () => {
  const VERIFIED: DecisionsStatus = { ...UNFINISHED, recoveryKitVerifiedAt: VERIFIED_AT };

  beforeEach(() => {
    exportRecoveryKit.mockReset();
    verifyRecoveryKit.mockReset();
    Object.defineProperty(window, "electron", {
      value: { decisions: { exportRecoveryKit, verifyRecoveryKit } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const toggle = () => screen.getByRole("button", { name: /Recovery kit verified/ });
  const saveRow = () => document.getElementById("decisions-recovery-kit-save");
  const verifyRow = () => document.getElementById("decisions-recovery-kit-verify");
  const bothFormsShown = () => saveRow() !== null && verifyRow() !== null;
  const anyFormShown = () => saveRow() !== null || verifyRow() !== null;

  function link(sectionId: string | null, query: string | null = "kit"): SettingsDeepLink {
    return {
      sectionId,
      query: sectionId === null ? null : query,
      // A link is its own request, even to the same section again.
      request: sectionId === null ? null : { sectionId },
      holds: null,
    };
  }

  function linkedTree(value: SettingsDeepLink) {
    return (
      <SettingsDeepLinkProvider value={value}>
        <TooltipProvider>
          <DecisionsRecoveryKit
            status={VERIFIED}
            disabled={false}
            onVerified={vi.fn()}
            focusRequest={0}
          />
        </TooltipProvider>
      </SettingsDeepLinkProvider>
    );
  }

  it("shows the status and a button for the forms, not the forms", () => {
    renderKit({ status: VERIFIED });

    expect(screen.getByText("Recovery kit verified")).toBeTruthy();
    expect(anyFormShown()).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBeNull();
  });

  it("shows the forms with no button while no kit is verified", () => {
    renderKit({ status: UNFINISHED });

    expect(bothFormsShown()).toBe(true);
    expect(screen.queryByRole("button", { name: /Save or verify a kit/ })).toBeNull();
  });

  it("names the button by its row's label and its own words, not the row's description", () => {
    renderKit({ status: VERIFIED });

    const [rowLabel, own, ...rest] = toggle().getAttribute("aria-labelledby")?.split(" ") ?? [];
    expect(document.getElementById(rowLabel ?? "")?.textContent).toBe("Recovery kit verified");
    expect(own).toBe(toggle().id);
    expect(rest).toEqual([]);
    expect(toggle().textContent).toBe("Save or verify a kit");
  });

  it("opens the forms from the button and folds them again, dropping what was typed and chosen", async () => {
    renderKit({ status: VERIFIED });

    fireEvent.click(toggle());
    expect(bothFormsShown()).toBe(true);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-controls")).toBe(
      "decisions-recovery-kit-save decisions-recovery-kit-verify"
    );
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    fireEvent.change(verifyField(), { target: { value: PASSPHRASE } });
    await chooseKit('{"v":1}', "mine.json");
    expect(screen.getByText("mine.json")).toBeTruthy();

    fireEvent.click(toggle());
    expect(anyFormShown()).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle());
    expect(saveField().value).toBe("");
    expect(verifyField().value).toBe("");
    expect(screen.getByText("No kit chosen")).toBeTruthy();
  });

  it("takes a form's result away with it when they are folded", async () => {
    exportRecoveryKit.mockResolvedValue({ result: "saved", fileName: "kit.json" });
    renderKit({ status: VERIFIED });
    fireEvent.click(toggle());
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());
    expect(screen.getByText("Saved kit.json")).toBeTruthy();

    fireEvent.click(toggle());

    expect(screen.queryByText("Saved kit.json")).toBeNull();
    expect(document.getElementById("decisions-recovery-kit-outcome")).toBeNull();
  });

  it("opens a folded kit for a request from setup that was there from the start", () => {
    const onFocused = vi.fn();
    renderKit({ status: VERIFIED, focusRequest: 1, onFocused });

    expect(bothFormsShown()).toBe(true);
    expect(document.activeElement).toBe(saveField());
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("opens a folded kit for a request from setup that comes after, and takes focus", () => {
    const onFocused = vi.fn();
    const { rerender } = renderKit({ status: VERIFIED, onFocused });
    expect(anyFormShown()).toBe(false);

    rerender(1);

    expect(bothFormsShown()).toBe(true);
    expect(document.activeElement).toBe(saveField());
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("lets the person fold the forms while a request from setup is still waiting for focus", () => {
    const onFocused = vi.fn();
    renderKit({ status: VERIFIED, focusRequest: 1, disabled: true, onFocused });
    expect(bothFormsShown()).toBe(true);
    expect(onFocused).not.toHaveBeenCalled();

    fireEvent.click(toggle());

    expect(anyFormShown()).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the forms, and the result, when a verification is what made the kit verified", async () => {
    verifyRecoveryKit.mockResolvedValue({ result: "verified", status: VERIFIED });
    const onVerified = vi.fn();
    const tree = (status: DecisionsStatus) => (
      <TooltipProvider>
        <DecisionsRecoveryKit
          status={status}
          disabled={false}
          onVerified={onVerified}
          focusRequest={0}
        />
      </TooltipProvider>
    );
    const view = render(tree(UNFINISHED));
    await chooseKit('{"v":1}');
    fireEvent.change(verifyField(), { target: { value: PASSPHRASE } });
    await submit(verifyField());
    expect(onVerified).toHaveBeenCalledWith(VERIFIED);

    view.rerender(tree(VERIFIED));

    expect(bothFormsShown()).toBe(true);
    expect(screen.getByText("Kit checked")).toBeTruthy();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("can't be folded while a save is running", async () => {
    const saving = deferred<DecisionsKitExportResult>();
    exportRecoveryKit.mockReturnValue(saving.promise);
    renderKit({ status: VERIFIED });
    fireEvent.click(toggle());
    fireEvent.change(saveField(), { target: { value: PASSPHRASE } });
    await submit(saveField());

    expect(toggle().hasAttribute("disabled")).toBe(true);
    expect(bothFormsShown()).toBe(true);

    await act(async () => saving.resolve({ result: "cancelled" }));
    expect(toggle().hasAttribute("disabled")).toBe(false);
  });

  it("can't be folded while a verification is running", async () => {
    const checking = deferred<DecisionsKitVerifyResult>();
    verifyRecoveryKit.mockReturnValue(checking.promise);
    renderKit({ status: VERIFIED });
    fireEvent.click(toggle());
    await chooseKit('{"v":1}');
    fireEvent.change(verifyField(), { target: { value: PASSPHRASE } });
    await submit(verifyField());

    expect(toggle().hasAttribute("disabled")).toBe(true);
    expect(bothFormsShown()).toBe(true);

    await act(async () => checking.resolve({ result: "verified", status: VERIFIED }));
    expect(toggle().hasAttribute("disabled")).toBe(false);
  });

  it("opens when the same relay's kit stops being verified", () => {
    const tree = (status: DecisionsStatus) => (
      <TooltipProvider>
        <DecisionsRecoveryKit
          status={status}
          disabled={false}
          onVerified={vi.fn()}
          focusRequest={0}
        />
      </TooltipProvider>
    );
    const view = render(tree(VERIFIED));
    expect(anyFormShown()).toBe(false);

    view.rerender(tree(UNFINISHED));

    expect(bothFormsShown()).toBe(true);
  });

  it("opens when the relay changes to one whose kit isn't verified", () => {
    const tree = (status: DecisionsStatus) => (
      <TooltipProvider>
        <DecisionsRecoveryKit
          status={status}
          disabled={false}
          onVerified={vi.fn()}
          focusRequest={0}
        />
      </TooltipProvider>
    );
    const view = render(tree(VERIFIED));

    view.rerender(tree({ ...UNFINISHED, relayOrigin: "https://other.example.workers.dev" }));

    expect(bothFormsShown()).toBe(true);
  });

  it.each(["decisions-recovery-kit-save", "decisions-recovery-kit-verify"])(
    "opens for a settings link to %s, and stays open once the link is cleared",
    (id) => {
      const view = render(linkedTree(link(id)));

      expect(bothFormsShown()).toBe(true);
      view.rerender(linkedTree(link(null)));
      expect(bothFormsShown()).toBe(true);
    }
  );

  it("opens again for a fresh link to the same form after the person folded it", () => {
    const view = render(linkedTree(link("decisions-recovery-kit-save")));
    view.rerender(linkedTree(link(null)));
    fireEvent.click(toggle());
    expect(anyFormShown()).toBe(false);

    view.rerender(linkedTree(link("decisions-recovery-kit-save")));

    expect(bothFormsShown()).toBe(true);
  });

  it.each(["decisions-data", "decisions-policy", "decisions-connection"])(
    "stays folded for a link to %s",
    (id) => {
      render(linkedTree(link(id)));

      expect(anyFormShown()).toBe(false);
    }
  );
});
