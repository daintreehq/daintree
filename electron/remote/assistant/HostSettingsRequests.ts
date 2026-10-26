import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import {
  HOST_SETTINGS_TOOL,
  type HostControlOutcomeCode,
  type HostSettingsArgs,
  type HostSettingsResult,
} from "../../../shared/types/hostControl.js";
import {
  ASSISTANT_HOST_SETTING_KEYS,
  HOST_SETTING_LABELS,
  hostSettingRefusal,
  isAssistantHostSettingKey,
  type AssistantHostSettingKey,
  type HostSettingKey,
  type HostSettingLeaf,
  type HostSettingsPatch,
  type HostSettingsSnapshot,
  type HostSettingsUpdatePayload,
  type HostSettingsUpdateResult,
} from "../../../shared/types/hostSettings.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import {
  CANOPY_STOP_ON_EACH,
  canopyLocalOn,
  canopyLocalOnHosts,
  canopyStopOn,
} from "../../../shared/config/canopyTerms.js";

type HostRow = HostSettingsResult["hosts"][number];
type AssistantValue = string | number | boolean | null;
interface AssistantLeaf {
  key: AssistantHostSettingKey;
  value: AssistantValue;
  revision: string;
}
type AssistantSnapshot = Omit<HostSettingsSnapshot, "settings"> & { settings: AssistantLeaf[] };

/** Only the leaves an assistant may see, whatever else a host's answer carries. */
function assistantLeaves(settings: readonly HostSettingLeaf[]): AssistantLeaf[] {
  return settings.flatMap(({ key, value, revision }) =>
    isAssistantHostSettingKey(key) && (typeof value !== "object" || value === null)
      ? [{ key, value, revision }]
      : []
  );
}
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
const READBACK_CONFLICT_DETAIL =
  "The host didn't answer, and what it holds now isn't what was asked: it changed there meanwhile, maybe after this change landed. Read it before trying again.";
const ALREADY_DETAIL = "Already set that way. Nothing was changed there.";
const PARTIAL_PREFIX = "Canopy was shown there, but not turned on. ";
const PARTIAL_CONFLICT_DETAIL = `${PARTIAL_PREFIX}It changed there meanwhile; preview again.`;
const PARTIAL_GONE_DETAIL = `${PARTIAL_PREFIX}The assistant was replaced or control was turned off.`;
const RATE_LIMITED_DETAIL =
  "The host is taking too many changes at once. Wait, then preview again.";
const UNREADABLE_DETAIL =
  "The host's answer couldn't be read. Its Daintree may be a different version.";

interface FrozenHost {
  hostId: HostId;
  name: string;
  instanceId: string;
  leaves: Array<{
    key: AssistantHostSettingKey;
    from: AssistantValue;
    to: AssistantValue;
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

function patchKeys(patch: HostSettingsPatch): AssistantHostSettingKey[] {
  return ASSISTANT_HOST_SETTING_KEYS.filter((key) => Object.hasOwn(patch, key));
}

function shown(key: HostSettingKey, value: AssistantValue): string {
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
    case "RATE_LIMITED":
      return { outcome: "rate_limited", detail: RATE_LIMITED_DETAIL, retryAfterMs: null };
    case "INTERNAL":
      return { outcome: "unsupported", detail: UNREADABLE_DETAIL, retryAfterMs: null };
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
        return this.read(args.hostIds ?? [], args.keys ?? [...ASSISTANT_HOST_SETTING_KEYS]);
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
  ): Promise<{ row: HostRow; snapshot: AssistantSnapshot | null }> {
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
      const read = await client.read({ hostId, keys });
      const snapshot: AssistantSnapshot = { ...read, settings: assistantLeaves(read.settings) };
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
    const wanted = ASSISTANT_HOST_SETTING_KEYS.filter((key) => keys.includes(key));
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
        to: patch[leaf.key] as AssistantValue,
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
      if (
        changes.some(
          (leaf) => leaf.key === "canopyMode" && leaf.from === "hidden" && leaf.to === "on"
        )
      ) {
        lines.push(`${host.name}: Canopy is hidden there, and will be shown first`);
      }
    }
    // What Settings says before Canopy is turned on there.
    const reading = ticket.hosts
      .filter((host) =>
        host.leaves.some(
          (leaf) => leaf.key === "canopyMode" && leaf.to === "on" && leaf.from !== "on"
        )
      )
      .map((host) => host.name);
    if (reading.length === 1) {
      lines.push(canopyLocalOn(reading[0]!), canopyStopOn(reading[0]!));
    } else if (reading.length > 1) {
      lines.push(canopyLocalOnHosts(reading), CANOPY_STOP_ON_EACH);
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
    const rows = await Promise.all(
      ticket.hosts.map((host) =>
        this.applyHost(host, () => stillRunning() && this.deps.controlOn(host.hostId))
      )
    );
    return { ...this.ok(), ticket: null, hosts: rows };
  }

  /**
   * One host's part of an approved ticket: one guarded update of every
   * setting the ticket changes there, which the host makes whole or not at
   * all, against the revisions and launch the preview froze. A hidden Canopy
   * being turned on takes a second guarded step, since the host shows it
   * before it can be turned on. Before each write the person's control switch
   * and the calling run are checked again; the values reported are the host's
   * own answers, never what the preview assumed.
   */
  private async applyHost(host: FrozenHost, authorized: () => boolean): Promise<HostRow> {
    const settings = new Map<AssistantHostSettingKey, AssistantValue>(
      host.leaves.map((leaf) => [leaf.key, leaf.from])
    );
    const row = (outcome: HostControlOutcomeCode, detail: string | null): HostRow => ({
      hostId: host.hostId,
      name: host.name,
      outcome,
      detail,
      settings: [...settings].map(([key, value]) => ({ key, value })),
    });
    const changes = host.leaves.filter((leaf) => leaf.from !== leaf.to);
    if (changes.length === 0) return row("ok", ALREADY_DETAIL);
    const client = this.deps.client();
    if (!client) return row("unsupported", UNSUPPORTED_DETAIL);

    const canopy = changes.find((leaf) => leaf.key === "canopyMode");
    const showFirst = canopy?.from === "hidden" && canopy.to === "on";
    let landed = false;
    /** The revisions the host last reported, for a second step to be made against. */
    const reported = new Map<HostSettingKey, string>();
    const step = async (
      patch: HostSettingsPatch,
      revisions: Partial<Record<HostSettingKey, string>>
    ): Promise<HostRow | null> => {
      if (!authorized()) return row("policy_rejected", landed ? PARTIAL_GONE_DETAIL : GONE_DETAIL);
      let result: HostSettingsUpdateResult;
      try {
        result = await client.update({
          hostId: host.hostId,
          patch,
          expect: { instanceId: host.instanceId, revisions },
        });
      } catch (error) {
        const refusal = hostOutcome(error);
        return row(
          refusal.outcome,
          landed ? `${PARTIAL_PREFIX}${refusal.detail ?? ""}` : refusal.detail
        );
      }
      for (const leaf of assistantLeaves(result.settings)) {
        settings.set(leaf.key, leaf.value);
        reported.set(leaf.key, leaf.revision);
      }
      switch (result.outcome) {
        case "applied":
          landed = true;
          return null;
        case "not-applied":
          return row("conflict", landed ? PARTIAL_CONFLICT_DETAIL : CONFLICT_DETAIL);
        case "conflict":
          if (result.confirmedBy === "reply") {
            return row("conflict", landed ? PARTIAL_CONFLICT_DETAIL : CONFLICT_DETAIL);
          }
          return row("ambiguous", READBACK_CONFLICT_DETAIL);
        case "unconfirmed":
          // What the preview read is no longer known to stand: left out, not repeated.
          for (const key of Object.keys(patch) as AssistantHostSettingKey[]) settings.delete(key);
          return row("ambiguous", UNCONFIRMED_DETAIL);
      }
    };

    const first = Object.fromEntries(
      changes.map((leaf) => [leaf.key, leaf.key === "canopyMode" && showFirst ? "unset" : leaf.to])
    ) as HostSettingsPatch;
    const stopped = await step(
      first,
      Object.fromEntries(changes.map((leaf) => [leaf.key, leaf.revision]))
    );
    if (stopped) return stopped;
    const shownAt = reported.get("canopyMode");
    if (showFirst && shownAt !== undefined) {
      const then = await step({ canopyMode: "on" }, { canopyMode: shownAt });
      if (then) return then;
    }
    return row("ok", null);
  }
}
