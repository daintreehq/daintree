import { useEffect, useState } from "react";
import { forgeClient } from "@/clients";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import type { Issue, IssueComment, Page } from "@shared/types/forge";
import {
  ISSUE_PROMPT_MAX_COMMENTS,
  formatIssuePromptContext,
  type IssuePromptComments,
  type IssuePromptContext,
} from "../issuePromptContext";

export const ISSUE_COMMENT_PAGE_SIZE = 100;
/**
 * Comments come oldest first, so the newest are only known once the thread is
 * read to its end. Past this many pages the thread is left out rather than
 * quoting comments that aren't the newest as if they were.
 */
export const ISSUE_COMMENT_MAX_PAGES = 3;
/** The whole read, issue and comments, gives up after this. */
export const ISSUE_PROMPT_READ_TIMEOUT_MS = 8_000;

export type IssuePromptRead =
  | {
      status: "ready";
      context: IssuePromptContext;
      comments: IssuePromptComments["status"];
    }
  /** `reason` is why the issue couldn't be read, in a few words or the forge's own. */
  | { status: "error"; reason: string };

export type IssuePromptContextState = { status: "off" } | { status: "loading" } | IssuePromptRead;

const OFF: IssuePromptContextState = { status: "off" };
const LOADING: IssuePromptContextState = { status: "loading" };

class ReadTimeout extends Error {}

/** Starts `read` only with time left, so no request is left running unobserved past the deadline. */
function beforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new ReadTimeout());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeout()), remaining);
  });
  return Promise.race([read(), expiry]).finally(() => clearTimeout(timer));
}

async function readRecentComments(
  cwd: string,
  issueNumber: number,
  deadline: number,
  isCancelled: () => boolean
): Promise<IssuePromptComments> {
  const recent: IssueComment[] = [];
  let total = 0;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < ISSUE_COMMENT_MAX_PAGES; page++) {
    let result: Page<IssueComment>;
    try {
      const pageCursor: string | null = cursor;
      result = await beforeDeadline(
        () =>
          forgeClient.listIssueComments(cwd, issueNumber, {
            perPage: ISSUE_COMMENT_PAGE_SIZE,
            ...(pageCursor ? { cursor: pageCursor } : {}),
          }),
        deadline
      );
    } catch (err) {
      return clientErrorCode(err) === "UNSUPPORTED"
        ? { status: "unsupported" }
        : { status: "failed" };
    }
    if (isCancelled()) return { status: "failed" };
    total += result.items.length;
    recent.push(...result.items);
    if (recent.length > ISSUE_PROMPT_MAX_COMMENTS) {
      recent.splice(0, recent.length - ISSUE_PROMPT_MAX_COMMENTS);
    }
    if (!result.hasMore) return { status: "read", recent, total };
    // More pages it can't reach: the end of the thread, and so its newest
    // comments, are unknown.
    // A cursor seen before goes round in a loop rather than to the end.
    if (!result.nextCursor || seenCursors.has(result.nextCursor)) return { status: "failed" };
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return { status: "too-long", read: total };
}

/**
 * Reads `issue` fresh from the project's issues provider, with its newest
 * comments where the provider has them, and quotes it for a first prompt. A
 * comments read that fails leaves the issue quoted without them; only the
 * issue itself failing is an error.
 */
export async function loadIssuePromptContext({
  cwd,
  issue,
  providerName,
  isCancelled = () => false,
}: {
  cwd: string;
  issue: Pick<Issue, "number">;
  providerName: string;
  isCancelled?: () => boolean;
}): Promise<IssuePromptRead> {
  const deadline = Date.now() + ISSUE_PROMPT_READ_TIMEOUT_MS;
  let fresh: Issue | null;
  try {
    fresh = await beforeDeadline(() => forgeClient.getIssue(cwd, issue.number), deadline);
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof ReadTimeout ? "timed out" : clientErrorText(err, "the read failed"),
    };
  }
  if (!fresh) return { status: "error", reason: "not found" };
  if (isCancelled()) return { status: "error", reason: "cancelled" };
  const comments = await readRecentComments(cwd, issue.number, deadline, isCancelled);
  return {
    status: "ready",
    context: formatIssuePromptContext({ issue: fresh, providerName, comments }),
    comments: comments.status,
  };
}

/**
 * The issue quote for a new worktree's first prompt, read while `enabled`.
 * A result is only ever shown for the issue, provider and attempt it was read
 * for, so switching issues never offers the last one's text; a read that
 * settles after it stopped mattering is dropped.
 */
export function useIssuePromptContext({
  enabled,
  cwd,
  issue,
  providerId,
  providerName,
}: {
  enabled: boolean;
  cwd: string;
  issue: Issue | null;
  providerId: string | null;
  providerName: string;
}): { state: IssuePromptContextState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ key: string; read: IssuePromptRead } | null>(null);
  const issueNumber = issue?.number ?? null;
  const key =
    enabled && issue
      ? [attempt, cwd, providerId ?? "", issue.id ?? "", issue.number].join("\u0000")
      : null;

  useEffect(() => {
    if (key === null || issueNumber === null) return;
    let cancelled = false;
    void loadIssuePromptContext({
      cwd,
      issue: { number: issueNumber },
      providerName,
      isCancelled: () => cancelled,
    })
      .catch((err: unknown): IssuePromptRead => ({
        status: "error",
        reason: clientErrorText(err, "the read failed"),
      }))
      .then((read) => {
        if (!cancelled) setSettled({ key, read });
      });
    return () => {
      cancelled = true;
      // Turned off, closed or moved on: a later read starts from loading, never
      // from this one's result, which may be long out of date by then.
      setSettled(null);
    };
  }, [key, cwd, issueNumber, providerName]);

  const state = key === null ? OFF : settled?.key === key ? settled.read : LOADING;
  return { state, retry: () => setAttempt((n) => n + 1) };
}
