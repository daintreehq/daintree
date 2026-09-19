// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { KeepAwakeConfig, KeepAwakeState } from "@shared/types";

const { clientMock, loadMock } = vi.hoisted(() => ({
  clientMock: {
    getState: vi.fn(),
    updateConfig: vi.fn(),
    onStateChanged: vi.fn(),
  },
  loadMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/clients/keepAwakeClient", () => ({ keepAwakeClient: clientMock }));
vi.mock("@/hooks/useKeepAwakeSync", () => ({ loadKeepAwakeState: loadMock }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { KeepAwakeSection } from "../KeepAwakeSection";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";

function makeState(
  config: Partial<KeepAwakeConfig> = {},
  isBlocking = false,
  revision = 1
): KeepAwakeState {
  return { config: { enabled: true, onBattery: false, ...config }, isBlocking, revision };
}

function switchFor(container: HTMLElement, label: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
  if (!el) throw new Error(`no switch labelled ${label}`);
  return el;
}

const MASTER = "Keep awake while agents work";
const BATTERY = "Keep awake on battery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function retryButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
}

beforeEach(() => {
  useKeepAwakeStore.setState({ state: null, loadError: null, visible: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("KeepAwakeSection", () => {
  it("shows the defaults locked until main's state lands", () => {
    const { container } = render(<KeepAwakeSection />);

    expect(container.querySelector("#general-keep-awake")).not.toBeNull();
    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("true");
    expect(switchFor(container, MASTER).disabled).toBe(true);
    expect(switchFor(container, BATTERY).disabled).toBe(true);
    expect(container.textContent).toContain(
      "Whether Daintree keeps this machine awake while agents work"
    );
    expect(container.textContent).not.toContain("isn't keeping");
  });

  it("shows both switches with the stored values", () => {
    useKeepAwakeStore.setState({ state: makeState({ onBattery: true }) });
    const { container } = render(<KeepAwakeSection />);

    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("true");
    expect(switchFor(container, BATTERY).getAttribute("aria-checked")).toBe("true");
    expect(switchFor(container, BATTERY).disabled).toBe(false);
  });

  it("disables the battery switch while keep-awake is off", () => {
    useKeepAwakeStore.setState({ state: makeState({ enabled: false, onBattery: true }) });
    const { container } = render(<KeepAwakeSection />);

    expect(switchFor(container, BATTERY).disabled).toBe(true);
    expect(switchFor(container, BATTERY).getAttribute("aria-checked")).toBe("true");
  });

  it("describes what main is doing rather than what the switches ask for", () => {
    useKeepAwakeStore.setState({ state: makeState({}, true) });
    const { container } = render(<KeepAwakeSection />);
    expect(container.textContent).toContain("Daintree is keeping this machine awake right now");

    act(() => {
      useKeepAwakeStore.getState().applyState(makeState({}, false, 2));
    });
    expect(container.textContent).toContain("Daintree isn't keeping this machine awake right now");
  });

  it("sends only the toggled field and applies the state main returns", async () => {
    useKeepAwakeStore.setState({ state: makeState() });
    clientMock.updateConfig.mockResolvedValue(makeState({ onBattery: true }, false, 2));
    const { container } = render(<KeepAwakeSection />);

    await act(async () => {
      fireEvent.click(switchFor(container, BATTERY));
    });

    expect(clientMock.updateConfig).toHaveBeenCalledWith({ onBattery: true });
    expect(useKeepAwakeStore.getState().state?.config.onBattery).toBe(true);
    expect(switchFor(container, BATTERY).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the requested value and locks both switches while saving", async () => {
    useKeepAwakeStore.setState({ state: makeState() });
    const save = deferred<KeepAwakeState>();
    clientMock.updateConfig.mockReturnValue(save.promise);
    const { container } = render(<KeepAwakeSection />);

    act(() => {
      fireEvent.click(switchFor(container, MASTER));
    });
    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("false");
    expect(switchFor(container, MASTER).disabled).toBe(true);
    expect(switchFor(container, BATTERY).disabled).toBe(true);

    await act(async () => {
      save.resolve(makeState({ enabled: false }, false, 2));
    });
    expect(switchFor(container, MASTER).disabled).toBe(false);
    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("false");
  });

  it("sends one request however often the switch is hit while one is in flight", () => {
    useKeepAwakeStore.setState({ state: makeState() });
    clientMock.updateConfig.mockReturnValue(deferred<KeepAwakeState>().promise);
    const { container } = render(<KeepAwakeSection />);
    const master = switchFor(container, MASTER);

    act(() => {
      master.click();
      master.click();
    });

    expect(clientMock.updateConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps showing another window's change to the field not being saved", async () => {
    useKeepAwakeStore.setState({ state: makeState() });
    const save = deferred<KeepAwakeState>();
    clientMock.updateConfig.mockReturnValue(save.promise);
    const { container } = render(<KeepAwakeSection />);

    act(() => {
      fireEvent.click(switchFor(container, BATTERY));
    });
    act(() => {
      useKeepAwakeStore.getState().applyState(makeState({ enabled: false }, false, 2));
    });

    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("false");
    expect(switchFor(container, BATTERY).getAttribute("aria-checked")).toBe("true");

    // The save's own reply was computed before the other window's change.
    await act(async () => {
      save.resolve(makeState({ onBattery: true }, false, 1));
    });
    expect(useKeepAwakeStore.getState().state?.revision).toBe(2);
  });

  it("rolls back and offers to resend the same change inline when saving fails", async () => {
    useKeepAwakeStore.setState({ state: makeState() });
    clientMock.updateConfig.mockRejectedValueOnce(new Error("store write failed"));
    const { container } = render(<KeepAwakeSection />);

    await act(async () => {
      fireEvent.click(switchFor(container, MASTER));
    });

    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Couldn't save keep-awake setting");
    expect(container.textContent).toContain("store write failed");

    clientMock.updateConfig.mockResolvedValueOnce(makeState({ enabled: false }, false, 2));
    await act(async () => {
      retryButton(container)!.click();
    });
    expect(clientMock.updateConfig).toHaveBeenLastCalledWith({ enabled: false });
    expect(useKeepAwakeStore.getState().state?.config.enabled).toBe(false);
    expect(container.textContent).not.toContain("Couldn't save keep-awake setting");
  });

  it("shows a load failure with a retry that reads again", () => {
    useKeepAwakeStore.setState({ loadError: "no handler" });
    const { container } = render(<KeepAwakeSection />);

    expect(container.textContent).toContain("Couldn't load keep-awake settings");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    act(() => {
      retry!.click();
    });
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});
