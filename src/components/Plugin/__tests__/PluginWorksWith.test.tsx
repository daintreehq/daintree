// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ProjectPluginInfo } from "@shared/types/plugin";
import { buildWorksWithPeers, PluginWorksWith } from "../PluginWorksWith";

function installed(
  name: string,
  {
    displayName,
    disabled = false,
    origin = "global",
  }: { displayName?: string; disabled?: boolean; origin?: "global" | "project" } = {}
) {
  return { origin, disabled, manifest: { name, ...(displayName ? { displayName } : {}) } };
}

function projectPlugin(id: string, overrides: Partial<ProjectPluginInfo> = {}): ProjectPluginInfo {
  return {
    projectId: "p1",
    id,
    displayName: id,
    version: "1.0.0",
    capabilities: [],
    dirName: id,
    state: "active",
    muted: false,
    collidesWithGlobal: false,
    ...overrides,
  } as ProjectPluginInfo;
}

describe("buildWorksWithPeers", () => {
  it("records each plugin under its manifest id, with whether it is turned off", () => {
    const peers = buildWorksWithPeers(
      [
        installed("acme.on", { displayName: "On" }),
        installed("acme.off", { disabled: true }),
        installed("acme.instance", { origin: "project" }),
      ],
      [
        projectPlugin("acme.local", { displayName: "Local", muted: true }),
        projectPlugin("acme.broken", { state: "invalid" }),
      ]
    );

    expect(Object.fromEntries(peers)).toEqual({
      "acme.on": { name: "On", turnedOff: false },
      "acme.off": { name: "acme.off", turnedOff: true },
      "acme.local": { name: "Local", turnedOff: true },
    });
  });

  it.each([
    [false, false, { name: "Installed copy", turnedOff: false }],
    [false, true, { name: "Installed copy", turnedOff: false }],
    [true, false, { name: "Project copy", turnedOff: false }],
    [true, true, { name: "Installed copy", turnedOff: true }],
  ])(
    "reads a shared id as off only when every copy is (installed off: %s, project off: %s)",
    (installedOff, projectOff, expected) => {
      const peers = buildWorksWithPeers(
        [installed("acme.shared", { displayName: "Installed copy", disabled: installedOff })],
        [projectPlugin("acme.shared", { displayName: "Project copy", muted: projectOff })]
      );

      expect(peers.get("acme.shared")).toEqual(expected);
    }
  );
});

describe("PluginWorksWith", () => {
  it("lists ids in the manifest's order, each with what this window can see of it", () => {
    render(
      <PluginWorksWith
        ids={["acme.zed", "acme.alpha", "acme.alpha-off"]}
        peers={
          new Map([
            ["acme.alpha", { name: "acme.alpha", turnedOff: false }],
            ["acme.alpha-off", { name: "Alpha Off", turnedOff: true }],
          ])
        }
      />
    );

    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "acme.zedNot installed",
      "acme.alphaInstalled",
      "Alpha Offacme.alpha-offInstalled, turned off",
    ]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
