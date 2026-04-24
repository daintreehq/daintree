// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TerminalIcon } from "../TerminalIcon";

function renderDefaultTerminalIcon(): string {
  return render(<TerminalIcon kind="terminal" />).container.innerHTML;
}

describe("TerminalIcon", () => {
  it("renders AI process icons for detected CLI processes in terminal panels", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(<TerminalIcon kind="terminal" detectedProcessId="claude" />);

    expect(container.innerHTML).not.toBe(fallback);
    expect(container.innerHTML).toContain("currentColor");
  });

  it("renders package-manager process icons for detected CLI processes", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(<TerminalIcon kind="terminal" detectedProcessId="npm" />);

    expect(container.innerHTML).not.toBe(fallback);
  });

  it("falls back to terminal icon when detected process is unknown", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(<TerminalIcon kind="terminal" detectedProcessId="unknown-tool" />);

    expect(container.innerHTML).toBe(fallback);
  });

  it("prefers explicit agent icon over detected process icon", () => {
    const npmDetected = render(<TerminalIcon kind="terminal" detectedProcessId="npm" />).container
      .innerHTML;

    // detectedAgentId is required for agent chrome; agentId (launch hint) alone is inert.
    const explicitAgent = render(
      <TerminalIcon
        kind="agent"
        agentId="claude"
        detectedAgentId="claude"
        detectedProcessId="npm"
      />
    ).container.innerHTML;

    const fallback = renderDefaultTerminalIcon();

    expect(explicitAgent).not.toBe(npmDetected);
    expect(explicitAgent).not.toBe(fallback);
  });

  it("prefers detectedAgentId over launch-time agentId", () => {
    // Both renders supply detectedAgentId so chrome lights up; the one with
    // detectedAgentId="gemini" must win over agentId="claude".
    const claudeLaunch = render(
      <TerminalIcon kind="agent" agentId="claude" detectedAgentId="claude" />
    ).container.innerHTML;
    const geminiDetected = render(
      <TerminalIcon kind="agent" agentId="claude" detectedAgentId="gemini" />
    ).container.innerHTML;
    const geminiOnly = render(
      <TerminalIcon kind="agent" agentId="gemini" detectedAgentId="gemini" />
    ).container.innerHTML;

    expect(geminiDetected).not.toBe(claudeLaunch);
    expect(geminiDetected).toBe(geminiOnly);
  });

  it("falls back to agentId when detectedAgentId is undefined", () => {
    const launchOnly = render(<TerminalIcon kind="agent" agentId="claude" />).container.innerHTML;
    const withUndefinedDetected = render(
      <TerminalIcon kind="agent" agentId="claude" detectedAgentId={undefined} />
    ).container.innerHTML;

    expect(withUndefinedDetected).toBe(launchOnly);
  });
});
