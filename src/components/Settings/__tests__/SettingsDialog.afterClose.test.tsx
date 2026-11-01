// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsTabClose } from "../settingsTabClose";

vi.mock("@/hooks/useProjectSettingsForm", () => ({
  useProjectSettingsForm: () => ({
    currentProject: null,
    projectIsLoading: false,
    flush: async () => {},
    saveNow: async () => {},
  }),
}));
vi.mock("@/components/Hosts/hostList", () => ({ useHostList: () => ({ hosts: [] }) }));
vi.mock("../pluginSettingsSearch", () => ({ usePluginSettingsSearchIndex: () => [] }));
vi.mock("../GeneralTab", () => ({ GeneralTab: () => <p>General page</p> }));
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  appClient: { getVersionInfo: () => Promise.resolve({ appVersion: "0.0.0", arch: "arm64" }) },
}));

const afterClose = vi.hoisted(() => vi.fn());
const answers = vi.hoisted(() => [] as boolean[]);
// The tab that closes the dialog with a follow-up, as a guided relay deploy does.
vi.mock("../Decisions/DecisionsSettingsTab", () => ({
  DecisionsSettingsTab: ({ onClose }: { onClose?: SettingsTabClose }) => (
    <button
      type="button"
      onClick={() => void onClose?.(afterClose).then((closed) => answers.push(closed))}
    >
      Close, then open something
    </button>
  ),
}));

import { SettingsDialog } from "../SettingsDialog";

vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => {});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

beforeEach(() => {
  afterClose.mockClear();
  answers.length = 0;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      ...window.electron,
      globalEnv: {
        get: vi.fn().mockResolvedValue({ GOOD: "1" }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
});

function closeButton() {
  return screen.findByRole("button", { name: "Close, then open something" });
}

function dialog(isOpen: boolean, onClose: () => void) {
  return <SettingsDialog isOpen={isOpen} onClose={onClose} defaultTab="environment" />;
}

async function openEnvironment(onClose: () => void) {
  const view = render(dialog(true, onClose));
  await waitFor(() => {
    expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
  });
  return view;
}

async function goToDecisions() {
  await act(async () => {
    fireEvent.click(document.getElementById("settings-tab-decisions")!);
  });
}

describe("a tab's close with a follow-up", () => {
  it("runs the follow-up once the dialog has gone, and only then", async () => {
    const onClose = vi.fn();
    const { rerender } = await openEnvironment(onClose);
    await goToDecisions();

    await act(async () => {
      fireEvent.click(await closeButton());
    });

    expect(answers).toEqual([true]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(afterClose).not.toHaveBeenCalled();

    rerender(dialog(false, onClose));
    await waitFor(() => expect(afterClose).toHaveBeenCalledOnce());
  });

  it("runs nothing and answers false when an unsaved setting holds the close", async () => {
    const onClose = vi.fn();
    await openEnvironment(onClose);
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    fireEvent.change(screen.getAllByLabelText(/^Name of variable \d+$/)[1]!, {
      target: { value: "1BAD" },
    });
    await goToDecisions();

    await act(async () => {
      fireEvent.click(await closeButton());
    });

    expect(answers).toEqual([false]);
    expect(onClose).not.toHaveBeenCalled();
    expect(afterClose).not.toHaveBeenCalled();
  });

  it("drops the follow-up when the dialog opens again before the close finished", async () => {
    const onClose = vi.fn();
    const { rerender } = await openEnvironment(onClose);
    await goToDecisions();
    await act(async () => {
      fireEvent.click(await closeButton());
    });

    rerender(dialog(false, onClose));
    rerender(dialog(true, onClose));
    rerender(dialog(false, onClose));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(afterClose).not.toHaveBeenCalled();
  });
});
