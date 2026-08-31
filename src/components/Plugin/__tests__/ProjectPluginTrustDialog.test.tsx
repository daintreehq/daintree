// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPluginTrustDialog } from "../ProjectPluginTrustDialog";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const setProjectPluginTrust = vi.fn<(decision: string) => Promise<void>>();

function button(label: string): HTMLElement {
  const match = screen.getAllByRole("button").find((el) => (el.textContent ?? "").trim() === label);
  if (!match) throw new Error(`no button labelled "${label}"`);
  return match;
}

beforeEach(() => {
  setProjectPluginTrust.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { plugin: { setProjectPluginTrust } },
  });
});

afterEach(() => {
  cleanup();
  __resetProjectPluginStoreForTesting();
});

function openPrompt() {
  act(() => {
    useProjectPluginStore.getState().openPrompt({
      projectId: "proj-a",
      plugins: [
        { id: "acme.dashboard", displayName: "Acme Dashboard" },
        { id: "acme.deploy-board", displayName: "Deploy Board" },
      ],
    });
  });
}

describe("ProjectPluginTrustDialog", () => {
  it("stays closed until the trust prompt arrives", () => {
    render(<ProjectPluginTrustDialog />);
    expect(document.querySelector('[data-testid="project-plugin-trust-dialog"]')).toBeNull();

    openPrompt();
    expect(document.querySelector('[data-testid="project-plugin-trust-dialog"]')).not.toBeNull();
  });

  it("names every plugin it is asking about rather than counting them", () => {
    render(<ProjectPluginTrustDialog />);
    openPrompt();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Acme Dashboard");
    expect(text).toContain("acme.dashboard");
    expect(text).toContain("Deploy Board");
    expect(text).toContain("acme.deploy-board");
  });

  it("states plainly that the code is unsandboxed and names agents", () => {
    render(<ProjectPluginTrustDialog />);
    openPrompt();

    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).toContain("runs with your account");
    expect(text).toContain("sandbox");
    expect(text).toContain("agents");
  });

  it("offers exactly the three answers, and no per-capability choice", () => {
    render(<ProjectPluginTrustDialog />);
    openPrompt();

    expect(button("Keep disabled")).toBeTruthy();
    expect(button("Enable for this session")).toBeTruthy();
    expect(button("Always enable")).toBeTruthy();

    // A capability list here would read as a set of togglable permissions.
    // There is no sandbox behind them, so the dialog must not imply one.
    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toContain("permission");
    expect(text).not.toContain("deny");
  });

  it.each([
    ["Keep disabled", "disabled"],
    ["Enable for this session", "session"],
    ["Always enable", "enabled"],
  ])("sends %s as %s", async (label, decision) => {
    render(<ProjectPluginTrustDialog />);
    openPrompt();

    await act(async () => {
      button(label).click();
    });

    expect(setProjectPluginTrust).toHaveBeenCalledWith(decision);
    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("records nothing when the dialog is dismissed without an answer", () => {
    render(<ProjectPluginTrustDialog />);
    openPrompt();

    act(() => {
      useProjectPluginStore.getState().dismissPrompt();
    });

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="project-plugin-trust-dialog"]')).toBeNull();
  });
});
