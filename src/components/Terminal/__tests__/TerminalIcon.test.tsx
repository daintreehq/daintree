// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TerminalIcon } from "../TerminalIcon";

function renderDefaultTerminalIcon(): string {
  return render(<TerminalIcon kind="terminal" type="terminal" />).container.innerHTML;
}

describe("TerminalIcon", () => {
  it("renders AI process icons for detected CLI processes in terminal panels", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon kind="terminal" type="terminal" detectedProcessId="claude" />
    );

    expect(container.innerHTML).not.toBe(fallback);
    expect(container.innerHTML).toContain("currentColor");
  });

  it("renders package-manager process icons for detected CLI processes", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon kind="terminal" type="terminal" detectedProcessId="npm" />
    );

    expect(container.innerHTML).not.toBe(fallback);
  });

  it("falls back to terminal icon when detected process is unknown", () => {
    const fallback = renderDefaultTerminalIcon();
    const { container } = render(
      <TerminalIcon kind="terminal" type="terminal" detectedProcessId="unknown-tool" />
    );

    expect(container.innerHTML).toBe(fallback);
  });

  it("prefers explicit agent icon over detected process icon", () => {
    const npmDetected = render(
      <TerminalIcon kind="terminal" type="terminal" detectedProcessId="npm" />
    ).container.innerHTML;

    const explicitAgent = render(
      <TerminalIcon kind="agent" type="claude" agentId="claude" detectedProcessId="npm" />
    ).container.innerHTML;

    const fallback = renderDefaultTerminalIcon();

    expect(explicitAgent).not.toBe(npmDetected);
    expect(explicitAgent).not.toBe(fallback);
  });
});
