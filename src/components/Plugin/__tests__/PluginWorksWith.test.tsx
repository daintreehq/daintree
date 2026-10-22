// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LoadedPluginInfo, ProjectPluginInfo } from "@shared/types/plugin";
import { buildWorksWithPeers, PluginWorksWith } from "../PluginWorksWith";

function installed(
  name: string,
  overrides: Partial<LoadedPluginInfo> & { displayName?: string } = {}
): LoadedPluginInfo {
  const { displayName, ...rest } = overrides;
  return {
    instanceId: name,
    origin: "global",
    projectId: null,
    manifest: { name, version: "1.0.0", ...(displayName ? { displayName } : {}) },
    disabled: false,
    ...rest,
  } as LoadedPluginInfo;
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
        installed("acme.instance", { origin: "project", instanceId: "project__p1__acme.instance" }),
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

  it("answers for the project's own copy when an installed plugin shares its id", () => {
    const peers = buildWorksWithPeers(
      [installed("acme.shared", { displayName: "Installed copy", disabled: true })],
      [projectPlugin("acme.shared", { displayName: "Project copy" })]
    );

    expect(peers.get("acme.shared")).toEqual({ name: "Project copy", turnedOff: false });
  });
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
