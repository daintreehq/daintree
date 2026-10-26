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
