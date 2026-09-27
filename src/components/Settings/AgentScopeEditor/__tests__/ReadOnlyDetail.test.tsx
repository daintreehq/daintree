// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReadOnlyDetail } from "../ReadOnlyDetail";
import type { AgentPreset } from "@/config/agents";

function renderDetail(env: Record<string, string>) {
  const preset: AgentPreset = { id: "ccr-router", name: "ccr:router", env };
  render(
    <ReadOnlyDetail
      scopeKind="ccr"
      selectedPreset={preset}
      agentName="Claude"
      agentCustomFlags=""
      effectiveSkipPerms={false}
      effectiveInline={undefined}
      onDuplicate={vi.fn()}
    />
  );
}

describe("ReadOnlyDetail environment", () => {
  /**
   * Router presets carry auth tokens, and this panel is read on shared
   * screens. Read-only is not the same as safe to show.
   */
  it("masks secret values, by name or by value", () => {
    renderDetail({
      ANTHROPIC_AUTH_TOKEN: "router-token-value",
      UPSTREAM: "sk-ant-api03-Zq8w3EhTn5vB7mJdX2fK",
    });
    expect(screen.queryByText("router-token-value")).toBeNull();
    expect(screen.queryByText("sk-ant-api03-Zq8w3EhTn5vB7mJdX2fK")).toBeNull();
    expect(screen.getByText("ANTHROPIC_AUTH_TOKEN")).toBeTruthy();
  });

  it("shows a masked value on request, and says it is hidden until then", () => {
    renderDetail({ ANTHROPIC_AUTH_TOKEN: "router-token-value" });
    expect(screen.getByText("Hidden")).toBeTruthy();
    fireEvent.click(screen.getByTestId("preset-env-reveal"));
    expect(screen.getByText("router-token-value")).toBeTruthy();
  });

  it("shows a shell reference in full, since it names the variable to set", () => {
    renderDetail({ ANTHROPIC_API_KEY: "${MY_API_KEY}" });
    expect(screen.getByText("${MY_API_KEY}")).toBeTruthy();
  });

  it("keeps endpoints and model ids readable", () => {
    renderDetail({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3456", MODEL: "claude-sonnet-5" });
    expect(screen.getByText("http://127.0.0.1:3456")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-5")).toBeTruthy();
  });
});
