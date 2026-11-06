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

    renderKit({ status: { ...UNFINISHED, recoveryKitVerifiedAt: VERIFIED_AT } });
    expect(screen.getByText("Recovery kit verified")).toBeTruthy();
    expect(document.querySelector("#decisions-recovery-kit-status")?.textContent ?? "").toContain(
      new Date(VERIFIED_AT).getFullYear().toString()
    );
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
