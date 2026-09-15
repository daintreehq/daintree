// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPluginTrustBanner } from "../ProjectPluginTrustBanner";
import { TooltipProvider } from "@/components/ui/tooltip";
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

/** The app mounts one TooltipProvider at its root; the banner's × explains itself through it. */
function renderBanner(siblings?: ReactNode) {
  return render(
    <TooltipProvider>
      {siblings}
      <ProjectPluginTrustBanner />
    </TooltipProvider>
  );
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

function openPrompt(
  plugins: { id: string; displayName: string }[] = [
    { id: "acme.dashboard", displayName: "Acme Dashboard" },
    { id: "acme.deploy-board", displayName: "Deploy Board" },
  ]
) {
  act(() => {
    useProjectPluginStore.getState().openPrompt({ projectId: "proj-a", plugins });
  });
}

describe("ProjectPluginTrustBanner", () => {
  it("renders nothing until the trust prompt arrives", () => {
    const { container } = renderBanner();
    expect(container.textContent).toBe("");

    openPrompt();
    expect(document.body.textContent).toContain("Enable this project's plugins?");
  });

  it("names every plugin it is asking about rather than counting them", () => {
    renderBanner();
    openPrompt();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Acme Dashboard");
    expect(text).toContain("Deploy Board");
  });

  it("states plainly that the code is unsandboxed and names agents", () => {
    renderBanner();
    openPrompt();

    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).toContain("runs with your account");
    expect(text).toContain("sandbox");
    expect(text).toContain("agents");
  });

  it("keeps the plugin's own words apart from ours, and never lets them hide the warning", () => {
    const name =
      "Acme Dashboard (official, verified, safe to enable, reviewed by the team, trusted)";
    renderBanner();
    openPrompt([{ id: "acme.dashboard", displayName: name }]);

    // The name is quoted and carries its full text as a title, so a bounded
    // render still discloses the whole string; the security sentence is never
    // inside anything that can clip it.
    const quoted = screen.getByTitle(name);
    expect(quoted.textContent).toBe(`“${name}”`);
    expect(quoted.className).toContain("truncate");
    const warning = screen.getByText(/runs with your account/);
    expect(warning.closest('[class*="truncate"]')).toBeNull();
  });

  it("offers exactly the three answers, and no per-capability choice", () => {
    renderBanner();
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

  it("puts the three answers before 'Decide later' in tab order", () => {
    renderBanner();
    openPrompt();

    const buttons = screen
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim());
    expect(buttons.indexOf("Decide later")).toBe(buttons.length - 1);
    expect(buttons.indexOf("Keep disabled")).toBeLessThan(buttons.indexOf("Decide later"));
  });

  it.each([
    ["Keep disabled", "disabled"],
    ["Enable for this session", "session"],
    ["Always enable", "enabled"],
  ])("sends %s as %s", async (label, decision) => {
    renderBanner();
    openPrompt();

    await act(async () => {
      button(label).click();
    });

    expect(setProjectPluginTrust).toHaveBeenCalledWith(decision);
    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("records nothing when it is dismissed without an answer", () => {
    const { container } = renderBanner();
    openPrompt();

    act(() => {
      screen.getByRole("button", { name: "Decide later" }).click();
    });

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(useProjectPluginStore.getState().prompt).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("leaves terminal focus alone when the prompt arrives", () => {
    renderBanner(<input aria-label="Terminal input" />);
    const terminal = screen.getByRole("textbox");
    terminal.focus();
    openPrompt();
    expect(document.activeElement).toBe(terminal);
  });

  it("keeps a failed decision visible and lets the user retry", async () => {
    setProjectPluginTrust.mockRejectedValueOnce(new Error("Couldn't save plugin trust"));
    renderBanner();
    openPrompt();

    await act(async () => button("Always enable").click());

    // The failure is announced through the banner's own polite region, not a
    // second, assertive live region nested inside it.
    expect(screen.getByRole("status").textContent).toContain("Couldn't save plugin trust");
    expect(document.querySelector('[role="alert"]')).toBeNull();
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
    renderBanner();
    openPrompt();
    const enable = button("Always enable");
    enable.focus();
    act(() => enable.click());

    expect(document.activeElement).toBe(enable);
    expect(enable.getAttribute("aria-busy")).toBe("true");
    // Decide later stays in the row — inert, so the controls beside it do not
    // shift — and it cannot hide a decision that is still being saved.
    const later = screen.getByRole("button", { name: "Decide later" });
    expect(later.hasAttribute("disabled")).toBe(true);
    act(() => later.click());
    expect(useProjectPluginStore.getState().prompt).not.toBeNull();
    act(() => button("Keep disabled").click());
    expect(setProjectPluginTrust).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("does not block: it renders as a status region, never a dialog", () => {
    renderBanner();
    openPrompt();

    // The whole point of #12212 was that a modal stole focus from the terminal
    // an agent was typing into. Nothing here may claim dialog semantics.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });
});
