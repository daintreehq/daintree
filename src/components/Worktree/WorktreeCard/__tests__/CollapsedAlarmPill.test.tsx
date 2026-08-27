/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CollapsedAlarmPill } from "../CollapsedAlarmPill";
import type { AlarmDescriptor } from "@/lib/worktreeAlarmTier";

const none: AlarmDescriptor = { tier: 0, kind: "none", label: "", tone: "none" };
const behind: AlarmDescriptor = { tier: 1, kind: "behind", label: "Behind", tone: "warning" };
const authFailed: AlarmDescriptor = {
  tier: 2,
  kind: "auth-failed",
  label: "Auth failed",
  tone: "warning",
};
const ciFailed: AlarmDescriptor = {
  tier: 3,
  kind: "ci-failed",
  label: "CI failed",
  tone: "error",
};

describe("CollapsedAlarmPill", () => {
  it("renders nothing for tier 0", () => {
    const { container } = render(<CollapsedAlarmPill alarm={none} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders CI failed chip with error tone", () => {
    const { getByTestId } = render(<CollapsedAlarmPill alarm={ciFailed} />);
    const pill = getByTestId("collapsed-alarm-pill");
    expect(pill.getAttribute("data-tone")).toBe("error");
    expect(pill.textContent).toBe("CI failed");
    expect(pill.getAttribute("data-alarm-kind")).toBe("ci-failed");
  });

  it("renders auth-failed chip with warning tone", () => {
    const { getByTestId } = render(<CollapsedAlarmPill alarm={authFailed} />);
    const pill = getByTestId("collapsed-alarm-pill");
    expect(pill.getAttribute("data-tone")).toBe("warning");
    expect(pill.textContent).toBe("Auth failed");
    expect(pill.getAttribute("data-alarm-kind")).toBe("auth-failed");
  });

  it("renders behind chip with warning tone", () => {
    const { getByTestId } = render(<CollapsedAlarmPill alarm={behind} />);
    const pill = getByTestId("collapsed-alarm-pill");
    expect(pill.getAttribute("data-tone")).toBe("warning");
    expect(pill.textContent).toBe("Behind");
    expect(pill.getAttribute("data-alarm-kind")).toBe("behind");
  });

  it("does not use accent classes", () => {
    const { getByTestId } = render(<CollapsedAlarmPill alarm={ciFailed} />);
    const pill = getByTestId("collapsed-alarm-pill");
    expect(pill.className).not.toContain("accent");
  });

  it("stays a non-interactive marker", () => {
    const { getByTestId } = render(<CollapsedAlarmPill alarm={ciFailed} />);
    const pill = getByTestId("collapsed-alarm-pill");
    expect(pill.tagName).toBe("SPAN");
    expect(pill.className).toContain("pointer-events-none");
    expect(pill.hasAttribute("tabindex")).toBe(false);
  });

  it("does not use transition-all", () => {
    const { getByTestId } = render(<CollapsedAlarmPill alarm={ciFailed} />);
    const pill = getByTestId("collapsed-alarm-pill");
    expect(pill.className).not.toContain("transition-all");
  });
});
