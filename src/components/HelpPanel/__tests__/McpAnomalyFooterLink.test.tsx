// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const dispatchMock = vi.fn();
const notifyMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

import { McpAnomalyFooterLink } from "../McpAnomalyFooterLink";
import { __resetMcpAnomalyStoreForTesting, useMcpAnomalyStore } from "@/store/mcpAnomalyStore";

beforeEach(() => {
  dispatchMock.mockReset();
  notifyMock.mockReset();
  __resetMcpAnomalyStoreForTesting();
});

afterEach(() => {
  cleanup();
  __resetMcpAnomalyStoreForTesting();
});

describe("McpAnomalyFooterLink", () => {
  it("renders nothing when there is no anomaly", () => {
    const { container } = render(<McpAnomalyFooterLink />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders singular copy for a single anomaly", () => {
    useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 1 });
    render(<McpAnomalyFooterLink />);
    expect(screen.getByRole("button").textContent).toBe("1 anomaly signal");
  });

  it("renders plural copy for multiple anomalies", () => {
    useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 3 });
    render(<McpAnomalyFooterLink />);
    expect(screen.getByRole("button").textContent).toBe("3 anomaly signals");
  });

  it("navigates to the MCP settings tab on click", () => {
    useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 2 });
    render(<McpAnomalyFooterLink />);
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "mcp" },
      { source: "user" }
    );
  });

  it("never calls notify()", () => {
    useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 1 });
    render(<McpAnomalyFooterLink />);
    fireEvent.click(screen.getByRole("button"));
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
