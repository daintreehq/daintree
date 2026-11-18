import type http from "node:http";
import {
  createDecisionsMcpHandler,
  type DecisionsBridge,
  type PaneAuthenticator,
} from "@daintreehq/decisions-client";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  AnswerDecisionQuestionPayload,
  DeclineDecisionQuestionPayload,
  DecisionAnswerResultRead,
  DecisionDeclineResultRead,
  DecisionFollowUpResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionCancelResult,
  DecisionQuestionDeclineResult,
  DecisionQuestionFollowUpResult,
  SendDecisionFollowUpPayload,
} from "../../../shared/types/decisionsQuestion.js";
import type { ListenerRoute } from "../mcp-server/listenerHold.js";
import { createPaneAccess, type PaneAccessSources } from "./paneAccess.js";
import { QuestionBridge } from "./questionBridge.js";
import type { QuestionReadScope } from "./questionContent.js";
import type { QuestionSource } from "./relayConnection.js";

export const DECISIONS_MCP_PATH = "/mcp/decisions";

/** The slice of a listener hold the route keeps (`McpServerService.holdListener`). */
export interface DecisionsListenerHold {
  /** The listener's port while the hold has it open; null otherwise. */
  readonly port: number | null;
  release(): Promise<void>;
}

export type DecisionsHoldListener = (
  id: string,
  route: ListenerRoute
) => Promise<DecisionsListenerHold>;

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ error: "not_found" }));
}

/**
 * `/mcp/decisions` on the loopback listener, while questions can be asked
 * (#16011). It holds the listener whether or not the MCP server is on, and
 * serves the library's handler there. The listener's duplicate-header, Host
 * and Origin checks run first; the handler then checks the Host again,
 * refuses any Origin at all, and authenticates every request by its pane
 * bearer. It keeps no session, so a revoked bearer is refused on its next
 * request. One handler serves the route's whole life, so a pane's rate limit
 * carries across relay attempts and listener moves. Agents get the library's
 * tools and words as they are, follow-ups and `get_decision`'s thread
 * included: the thread's messages are stored here since Daintree takes the
 * relay's thread events (#16231).
 */
export class DecisionsMcpRoute {
  private readonly handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  private port: number | null = null;
  private closed = false;
  private opening: Promise<DecisionsListenerHold | null> | null = null;

  constructor(
    bridge: DecisionsBridge,
    authenticator: PaneAuthenticator,
    private readonly holdListener: DecisionsHoldListener
  ) {
    this.handler = createDecisionsMcpHandler(bridge, authenticator, {
      path: DECISIONS_MCP_PATH,
      allowedHosts: () =>
        this.port === null ? [] : [`127.0.0.1:${this.port}`, `localhost:${this.port}`],
    });
  }

  /**
   * Takes the listener hold once `after` settles (the route this one replaces
   * letting go of it: there is one hold per id). Rejects if the hold can't be
   * had; a close meanwhile releases it, or never takes it.
   */
  open(after: Promise<void> = Promise.resolve()): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.opening ??= after.then(async () => {
      if (this.closed) return null;
      const hold = await this.holdListener("decisions", {
        path: DECISIONS_MCP_PATH,
        handle: (req, res, _url, port) => {
          if (this.closed) {
            notFound(res);
            return Promise.resolve();
          }
          this.port = port;
          return this.handler(req, res);
        },
      });
      if (!this.closed) return hold;
      await hold.release();
      return null;
    });
    return this.opening.then(() => {});
  }

  /**
   * The port agents reach the route on, once its hold is taken; null if the
   * hold couldn't be had, or once closed.
   */
  async listenerPort(): Promise<number | null> {
    if (this.closed) return null;
    const hold = await this.opening?.catch(() => null);
    return this.closed ? null : (hold?.port ?? null);
  }

  /** Refuses every request from now on, then lets the listener hold go. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    const hold = await this.opening?.catch(() => null);
    await hold?.release();
  }
}

export interface DecisionsMcpRouteSources extends PaneAccessSources {
  holdListener: DecisionsHoldListener;
}

/** The route a lifetime serves questions on: where launches point agents, and what it closes. */
export interface DecisionsQuestions {
  /** The listener port the route is served on; null while it has none (#16012). */
  listenerPort(): Promise<number | null>;
  /**
   * A person withdrawing one of a pane's questions from its view (#17099),
   * through the bridge agents ask on, so it takes its turn with their posts.
   */
  cancelForPerson(
    questionId: string,
    scope: QuestionReadScope
  ): Promise<DecisionQuestionCancelResult>;
  /**
   * The person's answer from Daintree's own view (#17101), signed with this
   * computer's key on the bridge agents ask on, which itself refuses an
   * agent's: `hostId` is this computer's.
   */
  answerForPerson(
    payload: AnswerDecisionQuestionPayload,
    hostId: string | null
  ): Promise<DecisionQuestionAnswerResult>;
  /** Where a person's answer stands, by its id. */
  answerResultForPerson(answerId: string): Promise<DecisionAnswerResultRead>;
  /**
   * The person's decline from Daintree's own view (#17239), signed with this
   * computer's key like their answer, on the same bridge.
   */
  declineForPerson(
    payload: DeclineDecisionQuestionPayload,
    hostId: string | null
  ): Promise<DecisionQuestionDeclineResult>;
  /** Where a person's decline stands, by its id. */
  declineResultForPerson(declineId: string): Promise<DecisionDeclineResultRead>;
  /**
   * The person's follow-up from Daintree's own view (#17238), signed as
   * their answer is, on the bridge that refuses an agent's.
   */
  followUpForPerson(
    payload: SendDecisionFollowUpPayload,
    hostId: string | null
  ): Promise<DecisionQuestionFollowUpResult>;
  /** Where a person's follow-up stands, by its id. */
  followUpResultForPerson(messageId: string): Promise<DecisionFollowUpResultRead>;
  close(): Promise<void>;
}

/**
 * Serves agents' questions over `source` on `/mcp/decisions` until closed,
 * once `after` (the previous route's close) has settled.
 */
export function openDecisionsMcpRoute(
  source: QuestionSource,
  sources: DecisionsMcpRouteSources,
  after?: Promise<void>
): DecisionsQuestions {
  const access = createPaneAccess(sources);
  const bridge = new QuestionBridge({ source, isCurrent: access.isCurrent });
  const route = new DecisionsMcpRoute(bridge, access.authenticator, sources.holdListener);
  route.open(after).catch((error: unknown) => {
    console.warn(
      `[Decisions] /mcp/decisions couldn't hold the MCP listener: ${formatErrorMessage(error, "unknown error")}`
    );
  });
  return {
    listenerPort: () => route.listenerPort(),
    cancelForPerson: (questionId, scope) => bridge.cancelForPerson(questionId, scope),
    answerForPerson: (payload, hostId) => bridge.answerForPerson(payload, hostId),
    answerResultForPerson: (answerId) => bridge.answerResultForPerson(answerId),
    declineForPerson: (payload, hostId) => bridge.declineForPerson(payload, hostId),
    declineResultForPerson: (declineId) => bridge.declineResultForPerson(declineId),
    followUpForPerson: (payload, hostId) => bridge.followUpForPerson(payload, hostId),
    followUpResultForPerson: (messageId) => bridge.followUpResultForPerson(messageId),
    close: () => route.close(),
  };
}
