// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";
import { TooltipProvider } from "@/components/ui/tooltip";

const openExternal = vi.hoisted(() => vi.fn());
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal } }));

import { PulseHealthSignals } from "../PulseHealthSignals";

function health(overrides: Partial<ForgeProjectHealthPayload> = {}): ForgeProjectHealthPayload {
  return {
    ciStatus: "none",
    issueCount: 12,
    prCount: 3,
    latestRelease: null,
    securityAlerts: { visible: false, count: 0 },
    mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
    repoUrl: "https://github.com/acme/widgets",
    hasRemote: true,
    loading: false,
    ...overrides,
  };
}

function renderSignals(payload: ForgeProjectHealthPayload) {
  return render(
    <TooltipProvider>
      <PulseHealthSignals health={payload} rangeDays={60} />
    </TooltipProvider>
  );
}

function issuesChip(): HTMLElement | undefined {
  return screen
    .queryAllByRole("button")
    .find((button) => /issues?\b/.test(button.textContent ?? ""));
}

describe("PulseHealthSignals issues chip (#13744)", () => {
  beforeEach(() => {
    openExternal.mockClear();
  });

  it("opens the code forge's issue list when issues aren't bound elsewhere", () => {
    renderSignals(health());
    fireEvent.click(issuesChip()!);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/widgets/issues");
  });

  it("opens the issues provider's list when the project binds one", () => {
    renderSignals(health({ issueCount: 7, issuesUrl: "https://tracker.invalid/team/ENG" }));
    const chip = issuesChip()!;
    expect(chip.textContent).toContain("7 issues");
    fireEvent.click(chip);
    expect(openExternal).toHaveBeenCalledWith("https://tracker.invalid/team/ENG");
  });

  it("hides only the issues chip when the tracker's count is unknown", () => {
    renderSignals(health({ issueCountUnavailable: true }));
    expect(issuesChip()).toBeUndefined();
    expect(screen.queryAllByRole("button").some((b) => /PRs/.test(b.textContent ?? ""))).toBe(true);
  });
});
