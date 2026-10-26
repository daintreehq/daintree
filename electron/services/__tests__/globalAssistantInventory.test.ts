import { describe, expect, it } from "vitest";
import {
  MAX_HOST_INVENTORY_BYTES,
  MAX_INVENTORY_HOSTS,
  buildHostInventoryBlock,
  type HostInventoryHost,
} from "../globalAssistantInventory.js";

const TAKEN_AT = Date.UTC(2026, 9, 26, 9, 30, 0);

function projects(count: number, prefix = "p") {
  return Array.from({ length: count }, (_, index) => ({
    projectId: `${prefix}-${index}`,
    name: `Project ${index}`,
    frontendAttached: index === 0,
  }));
}

function host(overrides: Partial<HostInventoryHost> = {}): HostInventoryHost {
  return {
    hostId: "local",
    name: "greg-mbp",
    connection: "connected",
    local: true,
    control: true,
    projects: projects(3),
    projectTotal: 3,
    ...overrides,
  };
}

function remote(hostId: string, overrides: Partial<HostInventoryHost> = {}): HostInventoryHost {
  return host({ hostId, name: `${hostId}-box`, local: false, ...overrides });
}

function build(hosts: HostInventoryHost[]): string {
  return buildHostInventoryBlock({ takenAt: TAKEN_AT, hosts });
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("buildHostInventoryBlock (#14547)", () => {
  it("dates the snapshot and names host.list as the live answer", () => {
    const block = build([host()]);
    expect(block).toContain("2026-10-26T09:30:00.000Z");
    expect(block).toContain("`host.list` is the live answer (with `includeAgents`");
    expect(block).toContain("reopens this conversation");
  });

  it("lists this machine and each remote host with their state and projects in order", () => {
    const block = build([
      host(),
      remote("h1"),
      remote("h2", { control: false, projects: null, projectTotal: null }),
    ]);
    const lines = block.split("\n");
    const local = lines.indexOf("- `local` `greg-mbp`: this machine, assistant control on");
    expect(local).toBeGreaterThan(-1);
    expect(lines[local + 1]).toBe("  - `p-0` `Project 0` (open in a window)");
    expect(lines[local + 2]).toBe("  - `p-1` `Project 1`");
    expect(block).toContain("- `h1` `h1-box`: connected, assistant control on");
    expect(block).toContain("- `h2` `h2-box`: connected, assistant control off");
    expect(block).toContain("projects not listed while assistant control is off");
    expect(block.indexOf("`h1`")).toBeLessThan(block.indexOf("`h2`"));
  });

  it("shows a disconnected host as disconnected and claims no projects for it", () => {
    const block = build([host(), remote("h1", { connection: "disconnected", projects: projects(4, "stale") })]);
    expect(block).toContain("- `h1` `h1-box`: disconnected, assistant control on");
    expect(block).toContain("projects not known while it isn't connected");
    expect(block).not.toContain("stale-");
  });

  it("keeps 200 projects under budget and counts the rest", () => {
    const block = build([host({ projects: projects(200), projectTotal: 200 })]);
    expect(bytes(block)).toBeLessThanOrEqual(MAX_HOST_INVENTORY_BYTES);
    const listed = block.split("\n").filter((line) => /^ {2}- `p-\d+`/.test(line)).length;
    expect(listed).toBeGreaterThan(0);
    expect(block).toContain(`…and ${200 - listed} more not listed`);
  });

  it("counts projects past what the host itself sent", () => {
    const block = build([host({ projects: projects(2), projectTotal: 40 })]);
    expect(block).toContain("…and 38 more not listed");
  });

  it("shares room so one host with hundreds of projects can't crowd out the next", () => {
    const hosts = [
      host({ projects: projects(500), projectTotal: 500 }),
      ...Array.from({ length: 5 }, (_, index) =>
        remote(`h${index}`, { projects: projects(300, `h${index}`), projectTotal: 300 })
      ),
    ];
    const block = build(hosts);
    expect(bytes(block)).toBeLessThanOrEqual(MAX_HOST_INVENTORY_BYTES);
    for (let index = 0; index < 5; index++) expect(block).toContain(`\`h${index}-0\``);
  });

  it("stays under budget with long multibyte names on every host", () => {
    const longName = "ü".repeat(39);
    const hosts = Array.from({ length: MAX_INVENTORY_HOSTS }, (_, index) =>
      remote(`host-${index}-${"x".repeat(40)}`, {
        name: longName,
        projects: projects(50).map((project) => ({ ...project, name: longName })),
        projectTotal: 50,
      })
    );
    expect(bytes(build(hosts))).toBeLessThanOrEqual(MAX_HOST_INVENTORY_BYTES);
  });

  it("names a fixed number of hosts and counts the rest", () => {
    const hosts = Array.from({ length: MAX_INVENTORY_HOSTS + 3 }, (_, index) => remote(`h${index}`));
    expect(build(hosts)).toContain("…and 3 more hosts not listed");
  });

  it("drops unsafe names whole and leaves the id, and skips a project whose id is unsafe", () => {
    const block = build([
      host({
        name: "evil`name",
        projects: [
          { projectId: "ok", name: "bad <!-- marker", frontendAttached: null },
          { projectId: "bad`id", name: "Fine", frontendAttached: null },
          { projectId: "rtl", name: "abc‮def", frontendAttached: null },
        ],
        projectTotal: 3,
      }),
    ]);
    expect(block).toContain("- `local`: this machine");
    expect(block).toContain("  - `ok`\n");
    expect(block).toContain("  - `rtl`\n");
    expect(block).not.toContain("bad`id");
    expect(block).not.toContain("<!--");
    expect(block).not.toContain("‮");
    expect(block).toContain("…and 1 more not listed");
  });

  it("says when a host has no projects, and when none could be read", () => {
    expect(build([host({ projects: [], projectTotal: 0 })])).toContain("  - no projects");
    expect(build([host({ projects: null, projectTotal: null })])).toContain(
      "projects not read in time"
    );
    expect(build([])).toContain("No hosts could be read; call `host.list`.");
  });
});
