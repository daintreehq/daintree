import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import type {
  HostControlOutcomeCode,
  HostSshHostKey,
  HostSshHostKeysArgs,
  HostSshHostKeysResult,
  HostSshListener,
  HostSshReading,
} from "../../../shared/types/hostControl.js";
import type { SshHostKeysAnswer } from "../../../shared/types/hostSshHostKeys.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import { matchesPinnedKey, type HostSshHostKeysRead } from "../client/HostSshHostKeysService.js";

export interface HostSshHostKeysToolDeps {
  /** The hosts this Shell knows, by id. */
  hostIds(): readonly HostId[];
  /** The person's "assistant control" switch for the host. */
  controlOn(hostId: HostId): boolean;
  /** The host last answered on another protocol version, so no link to it opens. */
  versionMismatch?(hostId: HostId): boolean;
  /** The Shell's reader (`HostSshHostKeysService`); absent where Remote Hosts can't reach hosts. */
  read?(hostId: HostId, signal?: AbortSignal): Promise<HostSshHostKeysRead>;
}

/**
 * What the listeners of one answer may take as compact JSON, leaving the
 * rest of the MCP text budget to the trust, outcome and detail around them.
 */
export const HOST_SSH_LISTENERS_BYTES_MAX = MCP_RESPONSE_TEXT_MAX_BYTES - 4 * 1024;

const LOCAL_DETAIL =
  "local is this machine, not a host. Read its keys with ssh-keygen -lf here. Name a host from host.list.";
const NO_HOST_DETAIL = "No host has that id here. host.list names them.";
const CONTROL_OFF_DETAIL =
  "The person turned assistant control off for this host, so its keys aren't read for you.";
const UNSUPPORTED_DETAIL = "Hosts' SSH keys can't be read from this machine.";
const VERSION_MISMATCH_DETAIL =
  "The host answered on another protocol version, so no link to it opens until one side is updated.";
const UNKNOWN_TRUST_DETAIL =
  "Read on the host, but what this link's ssh connection rested on couldn't be told, so no key is marked as Daintree's pin. Don't pin from this reading alone.";

/** Fixed text for each way a read ends; never what a host said. */
const READ_DETAILS: Record<
  Exclude<HostSshHostKeysRead["status"], "read" | "not-found">,
  { outcome: HostControlOutcomeCode; detail: string }
> = {
  disconnected: {
    outcome: "disconnected",
    detail:
      "There's no open link to this host, or it closed before answering. Nothing is dialled for this read: host.bringBack, then read again.",
  },
  unsupported: {
    outcome: "unsupported",
    detail: "The host runs a Daintree too old to read its SSH keys. Update it there.",
  },
  "no-answer": {
    outcome: "ambiguous",
    detail: "The host didn't answer in time. Reading again is safe.",
  },
  "rate-limited": {
    outcome: "rate_limited",
    detail: "The link is busy. Read again shortly.",
  },
  cancelled: { outcome: "ambiguous", detail: "The read was cancelled before it answered." },
  "invalid-answer": {
    outcome: "ambiguous",
    detail: "The host's answer wasn't a reading this machine accepts. Nothing from it is shown.",
  },
  failed: { outcome: "ambiguous", detail: "The read failed on the link. Reading again is safe." },
};

/** Fixed text for each of the Host's own answers. */
const ANSWER_DETAILS: Record<SshHostKeysAnswer["status"], string> = {
  reading:
    "Read on the host as its own user, from each sshd listener's public key files. It is worth what the trust is worth.",
  "no-sshd-visible": "The host's user sees no sshd listener on that machine.",
  "discovery-failed": "The host couldn't read its process table, so its sshd wasn't found.",
  "timed-out": "The host's read didn't finish in time. Reading again may.",
  "unsupported-platform": "The host's platform isn't one its SSH keys are read on.",
};

function refusal(
  outcome: "not_found" | "opted_out" | "unsupported",
  detail: string
): HostSshHostKeysResult {
  return { outcome, detail, retryAfterMs: null, trust: null, reading: null };
}

const utf8 = new TextEncoder();
const jsonBytes = (value: unknown): number => utf8.encode(JSON.stringify(value)).length;

/**
 * The Host's answer for an assistant: each key it read held against the pin,
 * paths only where a key is missing, and whole keys only, cut to fit one MCP
 * answer. A cut is said: the reading is then neither complete nor whole.
 */
export function projectSshReading(
  answer: SshHostKeysAnswer,
  pinnedKey: string | null,
  budget = HOST_SSH_LISTENERS_BYTES_MAX
): HostSshReading {
  if (answer.status !== "reading") return { status: answer.status };
  const listeners: HostSshListener[] = [];
  let used = 2;
  let cut = false;
  for (const listener of answer.listeners) {
    const projected: HostSshListener = {
      listenerId: listener.listenerId,
      complete: listener.complete,
      gaps: [...listener.gaps],
      listenAddresses: [...listener.listenAddresses],
      keys: [],
    };
    // Room for a `truncated` gap and the separator, should this one be cut.
    const shell = jsonBytes(projected) + jsonBytes("truncated") + 2;
    if (used + shell > budget) {
      cut = true;
      break;
    }
    used += shell;
    for (const key of listener.keys) {
      const row: HostSshHostKey =
        key.outcome === "read"
          ? {
              outcome: "read",
              type: key.type,
              publicKey: key.publicKey,
              fingerprint: key.fingerprint,
              matchesPin: matchesPinnedKey(key.publicKey, pinnedKey),
            }
          : { outcome: key.outcome, publicKeyPath: key.publicKeyPath };
      const size = jsonBytes(row) + 1;
      if (used + size > budget) {
        cut = true;
        break;
      }
      used += size;
      projected.keys.push(row);
    }
    if (projected.keys.length < listener.keys.length) {
      projected.complete = false;
      if (!projected.gaps.includes("truncated")) projected.gaps.push("truncated");
    }
    listeners.push(projected);
    if (cut) break;
  }
  return {
    status: "reading",
    complete: answer.complete && !cut,
    // A listener whose keys the Host itself cut says so in its gaps.
    truncated:
      answer.truncated ||
      cut ||
      answer.listeners.some((listener) => listener.gaps.includes("truncated")),
    listeners,
  };
}

/**
 * `host.sshHostKeys` for one of this machine's assistants (#18258): one
 * connected host's SSH host public keys, read there over the link, with the
 * trust that link rests on. Never dials.
 */
export async function runHostSshHostKeys(
  deps: HostSshHostKeysToolDeps,
  args: HostSshHostKeysArgs,
  signal?: AbortSignal
): Promise<HostSshHostKeysResult> {
  const { hostId } = args;
  if (hostId === LOCAL_HOST_ID) return refusal("unsupported", LOCAL_DETAIL);
  const read = deps.read;
  if (!read) return refusal("unsupported", UNSUPPORTED_DETAIL);
  if (!deps.hostIds().includes(hostId)) return refusal("not_found", NO_HOST_DETAIL);
  if (!deps.controlOn(hostId)) return refusal("opted_out", CONTROL_OFF_DETAIL);
  const answer = await read(hostId, signal);
  // Removed, or control turned off, while the host was reading: nothing it read goes out.
  if (answer.status === "not-found" || !deps.hostIds().includes(hostId)) {
    return refusal("not_found", NO_HOST_DETAIL);
  }
  if (!deps.controlOn(hostId)) return refusal("opted_out", CONTROL_OFF_DETAIL);
  if (answer.status === "disconnected" && deps.versionMismatch?.(hostId) === true) {
    return refusal("unsupported", VERSION_MISMATCH_DETAIL);
  }
  if (answer.status !== "read") {
    const { outcome, detail } = READ_DETAILS[answer.status];
    return { outcome, detail, retryAfterMs: null, trust: null, reading: null };
  }
  return {
    outcome: "ok",
    detail:
      answer.trust.basis === "unknown" && answer.answer.status === "reading"
        ? UNKNOWN_TRUST_DETAIL
        : ANSWER_DETAILS[answer.answer.status],
    retryAfterMs: null,
    trust: answer.trust,
    reading: projectSshReading(answer.answer, answer.pinnedKey),
  };
}
