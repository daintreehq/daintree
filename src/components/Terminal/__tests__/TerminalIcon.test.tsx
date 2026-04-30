// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TerminalIcon } from "../TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

function renderDefaultTerminalIcon(): string {
  return render(<TerminalIcon kind="terminal" chrome={deriveTerminalChrome()} />).container
    .innerHTML;
}

describe("TerminalIcon", () => {
  it("marks the rendered icon identity for automated chrome assertions", () => {
    const { container, rerender } = render(
      <TerminalIcon kind="terminal" chrome={deriveTerminalChrome({ detectedAgentId: "claude" })} />
    );

    expect(
      container.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id")
    ).toBe("claude");

    rerender(<TerminalIcon kind="terminal" chrome={deriveTerminalChrome()} />);

    expect(
      container.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id")
    ).toBe("terminal");
  });

  it("marks the resolved icon color for automated chrome assertions", () => {
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({
          launchAgentId: "claude",
          presetColor: "#3366ff",
        })}
      />
    );

    const icon = container.querySelector("[data-terminal-icon-id='claude']");
    expect(icon?.getAttribute("data-terminal-icon-color")).toBe("#3366ff");
    expect(icon?.querySelector("path")?.getAttribute("fill")).toBe("#3366ff");
  });

  it("lets an explicit brandColor override the chrome color marker", () => {
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({
          launchAgentId: "claude",
          presetColor: "#3366ff",
        })}
        brandColor="#ff6600"
      />
    );

    const icon = container.querySelector("[data-terminal-icon-id='claude']");
    expect(icon?.getAttribute("data-terminal-icon-color")).toBe("#ff6600");
    expect(icon?.querySelector("path")?.getAttribute("fill")).toBe("#ff6600");
  });

  it("renders AI process icons for detected CLI processes in terminal panels", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({ detectedProcessId: "claude" })}
      />
    );

    expect(container.innerHTML).not.toBe(fallback);
  });

  it("renders package-manager process icons for detected CLI processes", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon kind="terminal" chrome={deriveTerminalChrome({ detectedProcessId: "npm" })} />
    );

    expect(container.innerHTML).not.toBe(fallback);
  });

  it("falls back to terminal icon when detected process is unknown", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon
        kind="terminal"
        chrome={deriveTerminalChrome({ detectedProcessId: "unknown-tool" })}
      />
    );

    expect(container.innerHTML).toBe(fallback);
  });

  it("prefers explicit agent icon over detected process icon", () => {
    const npmDetected = render(
      <TerminalIcon kind="terminal" chrome={deriveTerminalChrome({ detectedProcessId: "npm" })} />
    ).container.innerHTML;

    // Agent runtime identity wins over process identity in the descriptor.
    const explicitAgent = render(
      <TerminalIcon
        kind="agent"
        chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "npm" })}
      />
    ).container.innerHTML;

    const fallback = renderDefaultTerminalIcon();

    expect(explicitAgent).not.toBe(npmDetected);
    expect(explicitAgent).not.toBe(fallback);
  });

  it("prefers detectedAgentId over launch-time agentId", () => {
    // Live detection wins over durable launch affinity.
    const claudeLaunch = render(
      <TerminalIcon kind="agent" chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
    ).container.innerHTML;
    const geminiDetected = render(
      <TerminalIcon
        kind="agent"
        chrome={deriveTerminalChrome({ launchAgentId: "claude", detectedAgentId: "gemini" })}
      />
    ).container.innerHTML;
    const geminiOnly = render(
      <TerminalIcon kind="agent" chrome={deriveTerminalChrome({ detectedAgentId: "gemini" })} />
    ).container.innerHTML;

    expect(geminiDetected).not.toBe(claudeLaunch);
    expect(geminiDetected).toBe(geminiOnly);
  });

  it("uses launch-time agent identity as chrome fallback until explicit exit", () => {
    const launchOnly = render(
      <TerminalIcon kind="agent" chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
    ).container.innerHTML;
    const generic = renderDefaultTerminalIcon();

    expect(launchOnly).not.toBe(generic);
  });

  it("returns to the generic terminal icon after explicit launch-agent exit", () => {
    const launchExited = render(
      <TerminalIcon
        kind="agent"
        chrome={deriveTerminalChrome({ launchAgentId: "claude", agentState: "exited" })}
      />
    ).container.innerHTML;
    const generic = renderDefaultTerminalIcon();

    expect(launchExited).toBe(generic);
  });
});
