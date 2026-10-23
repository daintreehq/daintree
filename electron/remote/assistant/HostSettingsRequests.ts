import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import {
  HOST_SETTINGS_TOOL,
  type HostControlOutcomeCode,
  type HostSettingsArgs,
  type HostSettingsResult,
} from "../../../shared/types/hostControl.js";
import {
  HOST_SETTING_KEYS,
  HOST_SETTING_LABELS,
  hostSettingRefusal,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsPatch,
  type HostSettingsSnapshot,
  type HostSettingsUpdatePayload,
  type HostSettingsUpdateResult,
} from "../../../shared/types/hostSettings.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import {
  enableCanopyOnHosts,
  type BulkModeState,
  type BulkResult,
  type BulkTransport,
} from "../../../shared/utils/canopyBulkEnable.js";

type HostRow = HostSettingsResult["hosts"][number];
type Detail = { outcome: HostControlOutcomeCode; detail: string | null; retryAfterMs: null };

export interface HostSettingsRequestDeps {
  /** The Shell's settings client, read at each call. */
  client(): {
    read(payload: { hostId: HostId; keys?: HostSettingKey[] }): Promise<HostSettingsSnapshot>;
    update(payload: HostSettingsUpdatePayload): Promise<HostSettingsUpdateResult>;
  } | null;
  /** This Shell's hosts by id, with the names it knows them by. */
  hostName(hostId: HostId): string | null;
  /** The person's per-host "assistant control" switch, read at each call. */
  controlOn(hostId: HostId): boolean;
  /**
   * Puts one change to the person in the calling assistant's window, with the
   * lines it shows. Null when it couldn't be asked; absent, nothing is ever applied.
   */
  askApproval?(ask: {
    helpSessionId: string;
    actionId: string;
    args: Record<string, unknown>;
    subject: string;
    lines: string[];
  }): Promise<McpConfirmationDecision | null>;
  now(): number;
  newId(): string;
}

/** Long enough to read a preview back to the person; past it, preview again. */
const TICKET_TTL_MS = 5 * 60_000;
const MAX_TICKETS_PER_SESSION = 4;

const LOCAL_DETAIL =
  "This machine's own settings are changed in its Settings, not through host.settings.";
const NO_HOST_DETAIL = "This Shell has no host with that id. List the hosts it knows.";
const CONTROL_OFF_DETAIL =
  "Assistant control is turned off for this host in this Shell's host settings. Only the person can turn it on.";
const UNSUPPORTED_DETAIL =
  "This host's Daintree is too old to change its settings from here. It needs a newer Daintree.";
const DISCONNECTED_DETAIL = "The host can't be reached right now. Read it again once it is back.";
const REFUSED_DETAIL_PREFIX = "The host refused the change: ";
const NOTHING_TO_DO_DETAIL = "Already set that way on every host named. Nothing to apply.";
const BLOCKED_DETAIL =
  "Not every host named could be read, so there is no ticket. Preview again with the hosts that can.";
const EXPIRED_DETAIL =
  "That ticket is spent, has expired, or isn't this assistant's. Preview again for a new one.";
const NO_ASK_DETAIL =
  "The person couldn't be asked here, so nothing was changed. Ask them to open the assistant's window, then apply a new preview.";
const REJECTED_DETAIL = "The person declined. Nothing was changed.";
const GONE_DETAIL =
  "The assistant was replaced or control was turned off while the person decided. Nothing was changed.";
const CONFLICT_DETAIL =
  "The setting changed there since the preview, or the host restarted. Nothing was changed; preview again.";
const UNCONFIRMED_DETAIL =
  "The host didn't answer and couldn't be read back. Read it before trying again.";

interface FrozenHost {
  hostId: HostId;
  name: string;
  instanceId: string;
  leaves: Array<{
    key: HostSettingKey;
    from: HostSettingValue;
    to: HostSettingValue;
    revision: string;
  }>;
}

interface Ticket {
  helpSessionId: string;
  expiresAt: number;
  digest: string;
  patch: HostSettingsPatch;
  hosts: FrozenHost[];
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function patchKeys(patch: HostSettingsPatch): HostSettingKey[] {
  return HOST_SETTING_KEYS.filter((key) => Object.hasOwn(patch, key));
}

function shown(key: HostSettingKey, value: HostSettingValue): string {
  if (value === null) return "not set";
  if (key === "canopyMode") return value === "unset" ? "off" : String(value);
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function hostOutcome(error: unknown): Detail {
  switch (codeOf(error)) {
    case "UNSUPPORTED":
      return { outcome: "unsupported", detail: UNSUPPORTED_DETAIL, retryAfterMs: null };
    case "NOT_FOUND":
      return { outcome: "not_found", detail: NO_HOST_DETAIL, retryAfterMs: null };
    case "VALIDATION":
    case "PERMISSION": {
      const said = (error as { userMessage?: unknown } | null)?.userMessage;
      return {
        outcome: "policy_rejected",
        detail: `${REFUSED_DETAIL_PREFIX}${typeof said === "string" ? said : "it gave no reason."}`,
        retryAfterMs: null,
      };
    }
    default:
      return { outcome: "disconnected", detail: DISCONNECTED_DETAIL, retryAfterMs: null };
  }
}

/**
 * `host.settings` for this machine's own assistants (#14167). A change is
 * always two calls: a preview, which reads every host named, freezes what it
 * read (values, revisions, the launch they were read in) behind a ticket here
 * and changes nothing; and an apply of that ticket, which asks the person in
 * the assistant's own window about exactly what was frozen and only then
 * writes it, against those same revisions. An approval is never taken from
 * the caller's arguments, and a ticket is spent by its first apply.
 */
export class HostSettingsRequests {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly deps: HostSettingsRequestDeps) {}

  dispose(): void {
    this.tickets.clear();
  }

  async run(
    helpSessionId: string,
    stillRunning: () => boolean,
    args: HostSettingsArgs
  ): Promise<HostSettingsResult> {
    switch (args.operation) {
      case "read":
        return this.read(args.hostIds ?? [], args.keys ?? [...HOST_SETTING_KEYS]);
      case "preview":
        return this.preview(helpSessionId, args.hostIds ?? [], args.patch ?? {});
      case "apply":
        return this.apply(helpSessionId, stillRunning, args.ticket ?? "");
    }
  }

  private ok(): Detail {
    return { outcome: "ok", detail: null, retryAfterMs: null };
  }

  private refusedRow(hostId: HostId, name: string, refusal: Detail): HostRow {
    return { hostId, name, outcome: refusal.outcome, detail: refusal.detail, settings: [] };
  }

  /** One host read, or the row saying why it couldn't be. */
  private async readHost(
    hostId: HostId,
    keys: HostSettingKey[]
  ): Promise<{ row: HostRow; snapshot: HostSettingsSnapshot | null }> {
    const name = hostId === LOCAL_HOST_ID ? "This machine" : this.deps.hostName(hostId);
    const refuse = (outcome: HostControlOutcomeCode, detail: string) => ({
      row: this.refusedRow(hostId, name ?? hostId, { outcome, detail, retryAfterMs: null }),
      snapshot: null,
    });
    if (hostId === LOCAL_HOST_ID) return refuse("policy_rejected", LOCAL_DETAIL);
    if (name === null) return refuse("not_found", NO_HOST_DETAIL);
    if (!this.deps.controlOn(hostId)) return refuse("opted_out", CONTROL_OFF_DETAIL);
    const client = this.deps.client();
    if (!client) return refuse("unsupported", UNSUPPORTED_DETAIL);
    try {
      const snapshot = await client.read({ hostId, keys });
      return {
        row: {
          hostId,
          name,
          outcome: "ok",
          detail: null,
          settings: snapshot.settings.map(({ key, value }) => ({ key, value })),
        },
        snapshot,
      };
    } catch (error) {
      return { row: this.refusedRow(hostId, name, hostOutcome(error)), snapshot: null };
    }
  }

  private async read(hostIds: HostId[], keys: HostSettingKey[]): Promise<HostSettingsResult> {
    const wanted = HOST_SETTING_KEYS.filter((key) => keys.includes(key));
    const rows = await Promise.all(
      [...new Set(hostIds)].map(async (hostId) => (await this.readHost(hostId, wanted)).row)
    );
    return { ...this.ok(), ticket: null, hosts: rows };
  }

  private async preview(
    helpSessionId: string,
    hostIds: HostId[],
    patch: HostSettingsPatch
  ): Promise<HostSettingsResult> {
    const keys = patchKeys(patch);
    for (const key of keys) {
      const reason = hostSettingRefusal(key, patch[key]);
      if (reason !== null) {
        return {
          outcome: "policy_rejected",
          detail: `${HOST_SETTING_LABELS[key]}: ${reason}`,
          retryAfterMs: null,
          ticket: null,
          hosts: [],
        };
      }
    }
    const reads = await Promise.all(
      [...new Set(hostIds)].map((hostId) => this.readHost(hostId, keys))
    );
    const frozen: FrozenHost[] = [];
    const rows: HostRow[] = reads.map(({ row, snapshot }) => {
      if (!snapshot) return row;
      const leaves = snapshot.settings.map((leaf) => ({
        key: leaf.key,
        from: leaf.value,
        to: patch[leaf.key] as HostSettingValue,
        revision: leaf.revision,
      }));
      frozen.push({ hostId: row.hostId, name: row.name, instanceId: snapshot.instanceId, leaves });
      return {
        ...row,
        settings: leaves.map(({ key, from, to }) => ({ key, value: from, proposed: to })),
      };
    });
    if (frozen.length < rows.length) {
      return { ...this.ok(), detail: BLOCKED_DETAIL, ticket: null, hosts: rows };
    }
    if (frozen.every((host) => host.leaves.every((leaf) => leaf.from === leaf.to))) {
      return { ...this.ok(), detail: NOTHING_TO_DO_DETAIL, ticket: null, hosts: rows };
    }
    const ticket = this.keep(helpSessionId, patch, frozen);
    return { ...this.ok(), ticket, hosts: rows };
  }

  private keep(helpSessionId: string, patch: HostSettingsPatch, hosts: FrozenHost[]): string {
    const now = this.deps.now();
    for (const [id, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(id);
    }
    const own = [...this.tickets].filter(([, entry]) => entry.helpSessionId === helpSessionId);
    while (own.length >= MAX_TICKETS_PER_SESSION) {
      const [oldest] = own.shift()!;
      this.tickets.delete(oldest);
    }
    const id = this.deps.newId();
    this.tickets.set(id, {
      helpSessionId,
      expiresAt: now + TICKET_TTL_MS,
      digest: canonicalArgsHash(HOST_SETTINGS_TOOL, { patch, hosts }),
      patch,
      hosts,
    });
    return id;
  }

  /** What the person reads: each host, each setting's change, and Canopy's consequence. */
  private lines(ticket: Ticket): string[] {
    const lines: string[] = [];
    for (const host of ticket.hosts) {
      const changes = host.leaves.filter((leaf) => leaf.from !== leaf.to);
      if (changes.length === 0) {
        lines.push(`${host.name}: already set, left as it is`);
        continue;
      }
      for (const leaf of changes) {
        lines.push(
          `${host.name}: ${HOST_SETTING_LABELS[leaf.key]} ${shown(leaf.key, leaf.from)} → ${shown(leaf.key, leaf.to)}`
        );
      }
      if (changes.some((leaf) => leaf.key === "canopyMode" && leaf.to === "on")) {
        lines.push(
          `${host.name}: Canopy will send that host's agent screens off the machine to be read`
        );
      }
      if (changes.some((leaf) => leaf.key === "canopyMode" && leaf.from === "hidden")) {
        lines.push(`${host.name}: Canopy is hidden there, and will be shown first`);
      }
    }
    return lines;
  }

  private async apply(
    helpSessionId: string,
    stillRunning: () => boolean,
    id: string
  ): Promise<HostSettingsResult> {
    const ticket = this.tickets.get(id);
    // One apply per preview: a retry previews again rather than asking twice.
    this.tickets.delete(id);
    const none = (outcome: HostControlOutcomeCode, detail: string): HostSettingsResult => ({
      outcome,
      detail,
      retryAfterMs: null,
      ticket: null,
      hosts: [],
    });
    if (
      !ticket ||
      ticket.helpSessionId !== helpSessionId ||
      ticket.expiresAt <= this.deps.now() ||
      canonicalArgsHash(HOST_SETTINGS_TOOL, { patch: ticket.patch, hosts: ticket.hosts }) !==
        ticket.digest
    ) {
      return none("expired", EXPIRED_DETAIL);
    }
    const off = ticket.hosts.find((host) => !this.deps.controlOn(host.hostId));
    if (off) {
      return {
        ...none("opted_out", CONTROL_OFF_DETAIL),
        hosts: [
          this.refusedRow(off.hostId, off.name, {
            outcome: "opted_out",
            detail: CONTROL_OFF_DETAIL,
            retryAfterMs: null,
          }),
        ],
      };
    }
    const ask = this.deps.askApproval;
    if (!ask) return none("policy_rejected", NO_ASK_DETAIL);
    const count = ticket.hosts.length;
    let decision: McpConfirmationDecision | null;
    try {
      decision = await ask({
        helpSessionId,
        actionId: HOST_SETTINGS_TOOL,
        args: { hostIds: ticket.hosts.map((host) => host.hostId), patch: ticket.patch },
        subject:
          count === 1
            ? `Change settings on ${ticket.hosts[0]!.name}`
            : `Change settings on ${count} hosts`,
        lines: this.lines(ticket),
      });
    } catch {
      decision = null;
    }
    if (decision === null) return none("policy_rejected", NO_ASK_DETAIL);
    if (decision !== "approved") return none("policy_rejected", REJECTED_DETAIL);
    if (!stillRunning() || ticket.hosts.some((host) => !this.deps.controlOn(host.hostId))) {
      return none("policy_rejected", GONE_DETAIL);
    }
    const rows = await Promise.all(ticket.hosts.map((host) => this.applyHost(host)));
    return { ...this.ok(), ticket: null, hosts: rows };
  }

  /**
   * One host's part of an approved ticket. Everything but turning Canopy on is
   * one guarded update; turning it on goes through the same run Settings'
   * bulk enable uses, which shows a hidden Canopy first and reads back what
   * landed, pinned to the revision and launch the preview saw.
   */
  private async applyHost(host: FrozenHost): Promise<HostRow> {
    const client = this.deps.client();
    if (!client) {
      return this.refusedRow(host.hostId, host.name, {
        outcome: "unsupported",
        detail: UNSUPPORTED_DETAIL,
        retryAfterMs: null,
      });
    }
    const changes = host.leaves.filter((leaf) => leaf.from !== leaf.to);
    const canopyOn = changes.find((leaf) => leaf.key === "canopyMode" && leaf.to === "on");
    const plain = changes.filter((leaf) => leaf !== canopyOn);
    const settings = new Map<HostSettingKey, HostSettingValue>(
      host.leaves.map((leaf) => [leaf.key, leaf.from])
    );
    const row = (outcome: HostControlOutcomeCode, detail: string | null): HostRow => ({
      hostId: host.hostId,
      name: host.name,
      outcome,
      detail,
      settings: [...settings].map(([key, value]) => ({ key, value })),
    });

    // Checked as a whole first, so a host where any of it moved is left
    // untouched rather than half changed; each write is guarded again below.
    try {
      const now = await client.read({ hostId: host.hostId, keys: changes.map((leaf) => leaf.key) });
      for (const leaf of now.settings) settings.set(leaf.key, leaf.value);
      const moved =
        now.instanceId !== host.instanceId ||
        changes.some(
          (leaf) => now.settings.find((fresh) => fresh.key === leaf.key)?.revision !== leaf.revision
        );
      if (moved) return row("conflict", CONFLICT_DETAIL);
    } catch (error) {
      const refusal = hostOutcome(error);
      return row(refusal.outcome, refusal.detail);
    }

    if (plain.length > 0) {
      let result: HostSettingsUpdateResult;
      try {
        result = await client.update({
          hostId: host.hostId,
          patch: Object.fromEntries(plain.map((leaf) => [leaf.key, leaf.to])) as HostSettingsPatch,
          expect: {
            instanceId: host.instanceId,
            revisions: Object.fromEntries(plain.map((leaf) => [leaf.key, leaf.revision])),
          },
        });
      } catch (error) {
        const refusal = hostOutcome(error);
        return row(refusal.outcome, refusal.detail);
      }
      for (const leaf of result.settings) settings.set(leaf.key, leaf.value);
      if (result.outcome === "conflict" || result.outcome === "not-applied") {
        return row("conflict", CONFLICT_DETAIL);
      }
      if (result.outcome === "unconfirmed") return row("ambiguous", UNCONFIRMED_DETAIL);
    }

    if (canopyOn) {
      const revision = Number(canopyOn.revision);
      const [result] = await enableCanopyOnHosts(
        [{ hostId: host.hostId, name: host.name }],
        { transportFor: () => this.canopyTransport(host.hostId) },
        new Map([[host.hostId, { hostEpoch: host.instanceId, modeRevision: revision }]])
      );
      const outcome = (result as BulkResult).outcome;
      if (outcome === "enabled" || outcome === "already-enabled") settings.set("canopyMode", "on");
      switch (outcome) {
        case "enabled":
        case "already-enabled":
          break;
        case "conflicted":
          return row("conflict", CONFLICT_DETAIL);
        case "refused":
          return row("policy_rejected", `${REFUSED_DETAIL_PREFIX}${result!.detail}`);
        case "unsupported":
          return row("unsupported", UNSUPPORTED_DETAIL);
        case "inaccessible":
          return row("disconnected", DISCONNECTED_DETAIL);
        case "uncertain":
          return row("ambiguous", UNCONFIRMED_DETAIL);
      }
    }
    return row("ok", null);
  }

  /** A host's Canopy mode as the bulk run reads and changes it, by name over the link. */
  private canopyTransport(hostId: HostId): BulkTransport {
    const stateOf = (instanceId: string | null, settings: HostSettingsSnapshot["settings"]) => {
      const leaf = settings.find((candidate) => candidate.key === "canopyMode");
      if (!leaf || instanceId === null) throw new Error("No Canopy mode in the reply");
      return {
        mode: leaf.value as BulkModeState["mode"],
        hostEpoch: instanceId,
        modeRevision: Number(leaf.revision),
      } satisfies BulkModeState;
    };
    return {
      getSnapshot: async () => {
        const client = this.deps.client();
        if (!client) throw new Error("No settings client");
        const snapshot = await client.read({ hostId, keys: ["canopyMode"] });
        return stateOf(snapshot.instanceId, snapshot.settings);
      },
      setMode: async (mode, expectRevision, expectHostEpoch) => {
        const client = this.deps.client();
        if (!client) throw new Error("No settings client");
        const result = await client.update({
          hostId,
          patch: { canopyMode: mode },
          expect: { instanceId: expectHostEpoch, revisions: { canopyMode: `${expectRevision}` } },
        });
        // No reply and no readback: the run reads the host again itself.
        if (result.outcome === "unconfirmed") throw new Error("Unconfirmed");
        return stateOf(result.instanceId, result.settings);
      },
      release: () => {},
    };
  }
}
