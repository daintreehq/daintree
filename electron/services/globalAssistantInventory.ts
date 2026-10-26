import type { HostListEntry } from "../../shared/types/hostControl.js";
import { cleanDisplayValue } from "./helpSessionProjectMetadata.js";

export const HOST_INVENTORY_START = "<!-- DAINTREE_HOST_INVENTORY_START -->";
export const HOST_INVENTORY_END = "<!-- DAINTREE_HOST_INVENTORY_END -->";

/**
 * The latest snapshot, rewritten on every launch including a resume. A
 * reopened conversation keeps the instructions it first read, so this file in
 * the Daintree-owned session folder is where it finds the current one.
 */
export const HOST_INVENTORY_FILE = "host-inventory.md";

/**
 * Claude Code runs SessionStart hooks when it reopens a conversation and adds
 * what they print to it, so a resumed Claude run is handed the file outright.
 * Relative: hooks run in the session folder, which is the assistant's cwd, and
 * `cat` reads the same in every shell Claude Code runs hooks in.
 */
export const HOST_INVENTORY_RESUME_HOOK = {
  matcher: "resume",
  hooks: [{ type: "command", command: `cat ${HOST_INVENTORY_FILE}` }],
} as const;

/**
 * The whole block, markers aside. It is a pointer list for the global
 * assistant's first turn (#14547), not the inventory: `host.list` is that.
 */
export const MAX_HOST_INVENTORY_BYTES = 4 * 1024;
/** Hosts named before the rest are only counted. */
export const MAX_INVENTORY_HOSTS = 12;
/** Projects named for one host before the rest are only counted. */
export const MAX_INVENTORY_PROJECTS_PER_HOST = 15;
const MAX_ID_BYTES = 128;
const MAX_NAME_BYTES = 80;

type ListedProject = NonNullable<HostListEntry["projects"]>[number];

/** One host as the snapshot names it: the pointer fields of a `host.list` entry. */
export interface HostInventoryHost {
  hostId: string;
  name: string;
  connection: HostListEntry["connection"];
  /** Whether `local` is this machine rather than a remote host. */
  local: boolean;
  /** The person's assistant-control switch for the host. */
  control: boolean;
  /** Most used first; null when they weren't read (disconnected, control off, or no answer in time). */
  projects: readonly ListedProject[] | null;
  /** How many projects the host has, when known; may exceed `projects.length`. */
  projectTotal: number | null;
}

export interface HostInventorySnapshot {
  takenAt: number;
  hosts: readonly HostInventoryHost[];
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8") + 1;
}

function hostState(host: HostInventoryHost): string {
  const control = host.control ? "assistant control on" : "assistant control off";
  if (host.local) return `this machine, ${control}`;
  return `${host.connection}, ${control}`;
}

/** Why a host's projects aren't listed, in words the agent can act on. */
function noProjectsReason(host: HostInventoryHost): string {
  if (!host.local && host.connection !== "connected") return "projects not known while it isn't connected";
  if (!host.control) return "projects not listed while assistant control is off";
  return "projects not read in time; `host.list` asks again";
}

function projectLine(project: ListedProject): string | null {
  const id = cleanDisplayValue(project.projectId, MAX_ID_BYTES);
  if (!id) return null;
  const name = cleanDisplayValue(project.name, MAX_NAME_BYTES);
  const open = project.frontendAttached === true ? " (open in a window)" : "";
  return `  - \`${id}\`${name ? ` \`${name}\`` : ""}${open}`;
}

/**
 * The block body. Every host listed gets its line before any project does, and
 * each host's projects share what room is left evenly with the hosts after it,
 * so one machine with hundreds of projects can't crowd the others out.
 */
export function buildHostInventoryBlock(snapshot: HostInventorySnapshot): string {
  const head = [
    "## Hosts and projects",
    "",
    `Snapshot taken ${new Date(snapshot.takenAt).toISOString()}, when Daintree started this run. It is a pointer list, not live state: \`host.list\` is the live answer (with \`includeAgents\` for running agents), and its projectIds are what \`host.call\` takes. Projects are most used first.`,
    "",
  ];
  const tail = [
    "",
    `Daintree rewrites this list into \`${HOST_INVENTORY_FILE}\` in your working folder every time it starts you, including when it reopens this conversation. If this conversation has been reopened since, the list above is stale: read that file, or call \`host.list\`.`,
    "",
  ];

  const hosts: Array<{ host: HostInventoryHost; line: string }> = [];
  for (const host of snapshot.hosts) {
    if (hosts.length >= MAX_INVENTORY_HOSTS) break;
    const id = cleanDisplayValue(host.hostId, MAX_ID_BYTES);
    if (!id) continue;
    const name = cleanDisplayValue(host.name, MAX_NAME_BYTES);
    hosts.push({ host, line: `- \`${id}\`${name ? ` \`${name}\`` : ""}: ${hostState(host)}` });
  }
  const unlistedHosts = snapshot.hosts.length - hosts.length;
  if (hosts.length === 0) head.push("- No hosts could be read; call `host.list`.");
  if (unlistedHosts > 0) tail.unshift(`- …and ${unlistedHosts} more hosts not listed`);

  let room =
    MAX_HOST_INVENTORY_BYTES -
    [...head, ...tail].reduce((sum, line) => sum + bytes(line), 0) -
    hosts.reduce((sum, { line }) => sum + bytes(line), 0);

  const body: string[] = [];
  hosts.forEach(({ host, line }, index) => {
    body.push(line);
    const projects = host.projects;
    // A host this Shell can't see now claims no projects, whatever it named before.
    if (projects === null || (!host.local && host.connection !== "connected")) {
      const reason = `  - ${noProjectsReason(host)}`;
      room -= bytes(reason);
      body.push(reason);
      return;
    }
    const total = Math.max(host.projectTotal ?? projects.length, projects.length);
    const share = Math.floor(room / (hosts.length - index));
    // Kept back for the "more" line, which names a count of at most a few digits.
    let spend = 40;
    let listed = 0;
    const lines: string[] = [];
    for (const project of projects) {
      if (listed >= MAX_INVENTORY_PROJECTS_PER_HOST) break;
      const entry = projectLine(project);
      if (!entry) continue;
      if (spend + bytes(entry) > share) break;
      spend += bytes(entry);
      lines.push(entry);
      listed++;
    }
    if (total === 0) lines.push("  - no projects");
    const left = total - listed;
    if (left > 0) lines.push(`  - …and ${left} more not listed (\`host.list\` pages them)`);
    for (const entry of lines) room -= bytes(entry);
    body.push(...lines);
  });

  return [...head, ...body, ...tail].join("\n");
}

/**
 * The file a reopened conversation reads: the same list, introduced as the one
 * that replaces any it was given before.
 */
export function buildHostInventorySidecar(snapshot: HostInventorySnapshot): string {
  return [
    "This is Daintree's current host and project inventory for the global assistant. It replaces any inventory earlier in this conversation.",
    "",
    buildHostInventoryBlock(snapshot),
  ].join("\n");
}
