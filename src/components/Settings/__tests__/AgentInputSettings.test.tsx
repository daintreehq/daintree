// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

import { AgentInputSettings } from "../AgentInputSettings";
import { useTerminalInputStore } from "@/store";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";

beforeEach(() => {
  dispatch.mockClear();
  useTerminalInputStore.setState({ hybridInputEnabled: true, hybridInputAutoFocus: true });
  Reflect.set(window, "electron", { remoteHosts: { isInUse: vi.fn().mockResolvedValue(false) } });
});

afterEach(cleanup);

describe("AgentInputSettings", () => {
  it("offers the focus choice as two options and dispatches the unchanged action", () => {
    render(<AgentInputSettings />);
    expect(screen.getByRole("radiogroup", { name: "Focus first" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    expect(dispatch).toHaveBeenCalledWith(
      "terminalConfig.setHybridInputAutoFocus",
      { enabled: false },
      { source: "user" }
    );
  });

  it("disables the focus choice while the hybrid input is off", () => {
    useTerminalInputStore.setState({ hybridInputEnabled: false });
    render(<AgentInputSettings />);
    const radio = screen.getByRole("radio", { name: "Terminal" });
    expect(radio.hasAttribute("disabled") || radio.getAttribute("aria-disabled") === "true").toBe(
      true
    );
    fireEvent.click(radio);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // First-run setup writes these same two settings, so its choices land here as modified.
  it("marks a non-default choice as modified, and its reset writes the default back", () => {
    render(<AgentInputSettings />);
    expect(screen.queryByRole("button", { name: /^Reset .* to default$/ })).toBeNull();

    cleanup();
    useTerminalInputStore.setState({ hybridInputAutoFocus: false });
    render(<AgentInputSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Focus first to default" }));
    expect(dispatch).toHaveBeenCalledWith(
      "terminalConfig.setHybridInputAutoFocus",
      { enabled: true },
      { source: "user" }
    );

    cleanup();
    useTerminalInputStore.setState({ hybridInputEnabled: false });
    render(<AgentInputSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Hybrid input to default" }));
    expect(dispatch).toHaveBeenCalledWith(
      "terminalConfig.setHybridInputEnabled",
      { enabled: true },
      { source: "user" }
    );
  });

  it("names this machine as the owner in a window attached to another host", () => {
    _resetHostPlatformForTests();
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
    try {
      render(<AgentInputSettings />);
      expect(screen.getByText(/^This (Mac|machine)$/)).toBeTruthy();
      expect(screen.queryByText("On studio-01")).toBeNull();
    } finally {
      delete window.__DAINTREE_HOST_ID__;
      _resetHostPlatformForTests();
    }
  });
});
