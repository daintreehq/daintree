/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { NodeStatusBadge } from "../NodeStatusBadge";
import type { TaskState } from "@shared/types/domain";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

describe("NodeStatusBadge", () => {
  const states: TaskState[] = [
    "draft",
    "queued",
    "running",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ];

  it.each(states)("renders status badge for %s", (status) => {
    render(<NodeStatusBadge status={status} />);
    const badge = screen.getByRole("status");
    expect(badge).toBeDefined();
  });

  it("applies pulse animation for running status", () => {
    render(<NodeStatusBadge status="running" />);
    const badge = screen.getByRole("status");
    expect(badge.className).toContain("animate-agent-pulse");
  });

  it("does not apply pulse for completed status", () => {
    render(<NodeStatusBadge status="completed" />);
    const badge = screen.getByRole("status");
    expect(badge.className).not.toContain("animate-agent-pulse");
  });

  it("shows correct aria-label for failed", () => {
    render(<NodeStatusBadge status="failed" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("aria-label")).toBe("Failed");
  });
});
