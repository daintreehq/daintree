import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrerequisiteCheckResult } from "@shared/types";

const healthCheck = vi.hoisted(() => vi.fn());
vi.mock("@/clients", () => ({ systemClient: { healthCheck } }));

import { recheckMissingPrerequisites, recheckPrerequisite } from "../recheckMissingPrerequisites";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";

function result(
  tool: string,
  severity: "fatal" | "warn",
  usable: boolean
): PrerequisiteCheckResult {
  return {
    tool,
    label: tool,
    available: usable,
    version: usable ? "1.0.0" : null,
    severity,
    meetsMinVersion: usable,
  };
}

beforeEach(() => {
  healthCheck.mockReset();
  useMissingPrerequisiteStore.setState({
    missing: [],
    dismissed: false,
    inlineSurfaceCount: 0,
    install: { jobId: "j", tool: "git", status: "error", statusLine: "", error: "boom" },
  });
});

describe("recheckPrerequisite", () => {
  it("probes every prerequisite afresh and answers for the one asked about", async () => {
    healthCheck.mockResolvedValue({
      prerequisites: [result("git", "fatal", false), result("node", "warn", true)],
      allRequired: false,
    });

    await expect(recheckPrerequisite("node")).resolves.toBe(true);
    // The full probe, which main never caches; the fatal-only one is.
    expect(healthCheck).toHaveBeenCalledWith({ force: true });
  });

  it("is false for an advised tool still missing, which the fatal check never probes", async () => {
    healthCheck.mockResolvedValue({
      prerequisites: [result("git", "fatal", true), result("gh", "warn", false)],
      allRequired: true,
    });

    await expect(recheckPrerequisite("gh")).resolves.toBe(false);
    await expect(recheckPrerequisite("not-probed")).resolves.toBe(false);
  });

  it("publishes only the fatal failures it found", async () => {
    healthCheck.mockResolvedValue({
      prerequisites: [result("git", "fatal", false), result("gh", "warn", false)],
      allRequired: false,
    });

    await recheckPrerequisite("gh");

    const { missing, install } = useMissingPrerequisiteStore.getState();
    expect(missing.map((p) => p.tool)).toEqual(["git"]);
    expect(install).toBe(null);
  });
});

describe("recheckMissingPrerequisites", () => {
  it("leaves a running install's state alone", async () => {
    const running = {
      jobId: "j",
      tool: "git",
      status: "running" as const,
      statusLine: "",
      error: null,
    };
    useMissingPrerequisiteStore.setState({ install: running });
    healthCheck.mockResolvedValue({ prerequisites: [], allRequired: true });

    await expect(recheckMissingPrerequisites()).resolves.toEqual([]);
    expect(healthCheck).toHaveBeenCalledWith({ fatalOnly: true, force: true });
    expect(useMissingPrerequisiteStore.getState().install).toEqual(running);
  });
});
