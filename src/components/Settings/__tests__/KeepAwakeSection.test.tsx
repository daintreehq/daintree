// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { KeepAwakeConfig, KeepAwakeState } from "@shared/types";

interface ToastArgs {
  type: string;
  title: string;
  actions: Array<{ label: string; onClick: () => void }>;
}

const { clientMock, notifyMock, loadMock } = vi.hoisted(() => ({
  clientMock: {
    getState: vi.fn(),
    updateConfig: vi.fn(),
    onStateChanged: vi.fn(),
  },
  notifyMock: vi.fn<(toast: ToastArgs) => void>(),
  loadMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/clients/keepAwakeClient", () => ({ keepAwakeClient: clientMock }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
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

const MASTER = "Keep Awake While Agents Work Toggle";
const BATTERY = "Keep Awake On Battery Toggle";

beforeEach(() => {
  useKeepAwakeStore.setState({ state: null, loadError: null, visible: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("KeepAwakeSection", () => {
  it("renders nothing until a state or an error lands", () => {
    const { container } = render(<KeepAwakeSection />);

    expect(container.innerHTML).toBe("");
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
    expect(container.textContent).toContain("Daintree is keeping this machine awake right now.");

    act(() => {
      useKeepAwakeStore.getState().applyState(makeState({}, false, 2));
    });
    expect(container.textContent).toContain("Daintree isn't keeping this machine awake right now.");
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
    let resolve!: (state: KeepAwakeState) => void;
    clientMock.updateConfig.mockReturnValue(
      new Promise<KeepAwakeState>((r) => {
        resolve = r;
      })
    );
    const { container } = render(<KeepAwakeSection />);

    act(() => {
      fireEvent.click(switchFor(container, MASTER));
    });
    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("false");
    expect(switchFor(container, MASTER).disabled).toBe(true);
    expect(switchFor(container, BATTERY).disabled).toBe(true);

    await act(async () => {
      resolve(makeState({ enabled: false }, false, 2));
    });
    expect(switchFor(container, MASTER).disabled).toBe(false);
    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("false");
  });

  it("rolls back and offers to resend the same change when saving fails", async () => {
    useKeepAwakeStore.setState({ state: makeState() });
    clientMock.updateConfig.mockRejectedValueOnce(new Error("store write failed"));
    const { container } = render(<KeepAwakeSection />);

    await act(async () => {
      fireEvent.click(switchFor(container, MASTER));
    });

    expect(switchFor(container, MASTER).getAttribute("aria-checked")).toBe("true");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Couldn't save setting");
    expect(toast.actions.map((a) => a.label)).toEqual(["Try again"]);

    clientMock.updateConfig.mockResolvedValueOnce(makeState({ enabled: false }, false, 2));
    await act(async () => {
      toast.actions[0]!.onClick();
    });
    expect(clientMock.updateConfig).toHaveBeenLastCalledWith({ enabled: false });
    expect(useKeepAwakeStore.getState().state?.config.enabled).toBe(false);
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
