// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPluginTrustBanner } from "../ProjectPluginTrustBanner";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";

const setProjectPluginTrust = vi.fn<(decision: string) => Promise<void>>();

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

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

describe("ProjectPluginTrustBanner", () => {
  it("renders nothing until the trust prompt arrives", () => {
    const { container } = render(<ProjectPluginTrustBanner />);
    expect(container.textContent).toBe("");

    openPrompt();
    expect(document.body.textContent).toContain("Enable this project's plugins?");
  });

  it("names every plugin it is asking about rather than counting them", () => {
    render(<ProjectPluginTrustBanner />);
    openPrompt();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Acme Dashboard");
    expect(text).toContain("Deploy Board");
  });

  it("states plainly that the code is unsandboxed and names agents", () => {
    render(<ProjectPluginTrustBanner />);
    openPrompt();

    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).toContain("runs with your account");
    expect(text).toContain("sandbox");
    expect(text).toContain("agents");
  });

  it("offers exactly the three answers, and no per-capability choice", () => {
    render(<ProjectPluginTrustBanner />);
    openPrompt();

    expect(button("Keep disabled")).toBeTruthy();
    expect(button("Enable for this session")).toBeTruthy();
    expect(button("Always enable")).toBeTruthy();

    // A capability list here would read as a set of togglable permissions.
    // There is no sandbox behind them, so the gate must not imply one.
    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toContain("permission");
    expect(text).not.toContain("deny");
  });

  it.each([
    ["Keep disabled", "disabled"],
    ["Enable for this session", "session"],
    ["Always enable", "enabled"],
  ])("sends %s as %s", async (label, decision) => {
    render(<ProjectPluginTrustBanner />);
    openPrompt();

    await act(async () => {
      button(label).click();
    });

    expect(setProjectPluginTrust).toHaveBeenCalledWith(decision);
    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("records nothing when it is dismissed without an answer", () => {
    const { container } = render(<ProjectPluginTrustBanner />);
    openPrompt();

    act(() => {
      screen.getByRole("button", { name: "Decide later" }).click();
    });

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(useProjectPluginStore.getState().prompt).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("leaves terminal focus alone when the prompt arrives", () => {
    render(
      <>
        <input aria-label="Terminal input" />
        <ProjectPluginTrustBanner />
      </>
    );
    const terminal = screen.getByRole("textbox");
    terminal.focus();
    openPrompt();
    expect(document.activeElement).toBe(terminal);
  });

  it("keeps a failed decision visible and lets the user retry", async () => {
    setProjectPluginTrust.mockRejectedValueOnce(new Error("Couldn't save plugin trust"));
    render(<ProjectPluginTrustBanner />);
    openPrompt();

    await act(async () => button("Always enable").click());

    expect(screen.getByRole("alert").textContent).toContain("Couldn't save plugin trust");
    expect(useProjectPluginStore.getState().prompt).not.toBeNull();
    await act(async () => button("Always enable").click());
    expect(setProjectPluginTrust).toHaveBeenCalledTimes(2);
    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("holds the pending choice until it settles", async () => {
    let resolve!: () => void;
    setProjectPluginTrust.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    render(<ProjectPluginTrustBanner />);
    openPrompt();
    const enable = button("Always enable");
    enable.focus();
    act(() => enable.click());

    expect(document.activeElement).toBe(enable);
    expect(enable.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Decide later" })).toBeNull();
    act(() => button("Keep disabled").click());
    expect(setProjectPluginTrust).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("does not block: it renders as a status region, never a dialog", () => {
    render(<ProjectPluginTrustBanner />);
    openPrompt();

    // The whole point of #12212 was that a modal stole focus from the terminal
    // an agent was typing into. Nothing here may claim dialog semantics.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });
});
