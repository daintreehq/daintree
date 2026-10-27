import { useEffect, useState } from "react";
import { forgeClient } from "@/clients/forgeClient";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import type { ForgeReferencePrefixes, ListOptions } from "@shared/types/forge";
import { toForgeReferences, type ForgeReference } from "../forgeReferences";

const LIST_OPTIONS: ListOptions = {
  state: "open",
  sort: "updated",
  direction: "desc",
  perPage: 50,
};
const FRESH_MS = 45_000;
// A project with no credential fails every time; this keeps each `#` it's
// typed in from asking again.
const FAILED_MS = 15_000;

interface Slot {
  refs: ForgeReference[] | null;
  settledAt: number;
  failed: boolean;
  inFlight: Promise<void> | null;
}

// Shared by every composer in this project's view, so a fleet of panes typing
// `#` asks the forge once: both list channels are rate limited per call.
const slots = new Map<string, Slot>();
// Bumped when any remote changes: a remote can move to another repository on
// the same forge, which changes nothing in a slot's key.
let generation = 0;
let unwatchRemotes: (() => void) | null = null;

function watchRemotes(): void {
  if (unwatchRemotes) return;
  const forge = window.electron?.forge;
  if (typeof forge?.onRemoteChanged !== "function") return;
  unwatchRemotes = forge.onRemoteChanged(() => {
    generation++;
    slots.clear();
  });
}

const NO_REFERENCES: ForgeReference[] = [];

async function fetchReferences(
  cwd: string,
  prefixes: ForgeReferencePrefixes
): Promise<ForgeReference[] | null> {
  const [issues, prs] = await Promise.allSettled([
    prefixes.issue ? forgeClient.listIssues(cwd, LIST_OPTIONS) : null,
    prefixes.pr ? forgeClient.listPRs(cwd, LIST_OPTIONS) : null,
  ]);
  // One list failing still leaves the other's rows; nothing from any list it
  // asked is a failure, held for FAILED_MS.
  const noIssues = !prefixes.issue || issues.status === "rejected";
  const noPRs = !prefixes.pr || prs.status === "rejected";
  if (noIssues && noPRs) return null;
  return toForgeReferences(
    issues.status === "fulfilled" ? (issues.value?.items ?? []) : [],
    prs.status === "fulfilled" ? (prs.value?.items ?? []) : [],
    prefixes
  );
}

function refresh(key: string, cwd: string, prefixes: ForgeReferencePrefixes): Promise<void> {
  watchRemotes();
  const slot = slots.get(key);
  if (slot?.inFlight) return slot.inFlight;
  if (slot && Date.now() - slot.settledAt < (slot.failed ? FAILED_MS : FRESH_MS)) {
    return Promise.resolve();
  }
  const startedIn = generation;
  const inFlight = fetchReferences(cwd, prefixes)
    .catch(() => null)
    .then((refs) => {
      // Asked of a remote that has since changed: the answer is another repository's.
      if (generation !== startedIn) return;
      slots.set(key, { refs, settledAt: Date.now(), failed: refs === null, inFlight: null });
    });
  slots.set(key, {
    refs: slot?.refs ?? null,
    settledAt: slot?.settledAt ?? 0,
    failed: slot?.failed ?? false,
    inFlight,
  });
  return inFlight;
}

export function _resetForgeReferencesForTests(): void {
  slots.clear();
  unwatchRemotes?.();
  unwatchRemotes = null;
}

interface UseForgeReferencesParams {
  projectId: string | null | undefined;
  cwd: string;
  /** A `#` token is being typed; nothing is resolved or fetched otherwise. */
  enabled: boolean;
}

/**
 * The open issues and pull requests the `#` menu offers, fetched when a `#`
 * token starts and kept for a while, so the query narrows them without asking
 * the forge again. Empty whenever there is nothing to offer: no provider, a
 * provider that declares no reference prefixes, no credential, or a failed
 * fetch — and the `#` menu only opens on rows.
 */
export function useForgeReferences({
  projectId,
  cwd,
  enabled,
}: UseForgeReferencesParams): ForgeReference[] {
  const forge = useResolvedForgeProvider(enabled ? projectId : null);
  const declared = forge.entry?.contribution.referencePrefixes;
  // Issues bound to another tracker are numbered there, not in this repository.
  const issuePrefix = forge.issues.resolvedVia === "code" ? declared?.issue : undefined;
  const prPrefix = declared?.pr;
  const key =
    enabled && cwd && forge.providerId !== null && (issuePrefix || prPrefix)
      ? JSON.stringify([cwd, forge.providerId, forge.issues.providerId, issuePrefix, prPrefix])
      : null;

  const [answer, setAnswer] = useState<{ key: string; refs: ForgeReference[] } | null>(null);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const publish = () => {
      if (cancelled) return;
      const refs = slots.get(key)?.refs ?? null;
      setAnswer(refs ? { key, refs } : null);
    };
    // What's cached shows at once; a refresh replaces it if it's due.
    publish();
    void refresh(key, cwd, { issue: issuePrefix, pr: prPrefix }).then(publish);
    return () => {
      cancelled = true;
    };
  }, [key, cwd, issuePrefix, prPrefix]);

  return answer !== null && answer.key === key ? answer.refs : NO_REFERENCES;
}
