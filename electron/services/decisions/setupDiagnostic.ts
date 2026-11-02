import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  paneIdentityOf,
  sameTarget,
  targetOf,
  type AttachmentResolver,
  type InjectResult,
  type LocateResult,
  type PaneIdentity,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from "@daintreehq/decisions-client";
import type { DecisionsSetupDiagnosticTerminal } from "../../../shared/types/decisions.js";
import { parseAnswerNotice, renderDecisionSection } from "./answerNotice.js";

/** Every setup check's diagnostic terminal has a pane id with this prefix, and no real pane does. */
export const SETUP_DIAGNOSTIC_PANE_PREFIX = "daintree-decisions-check-";

export const SETUP_DIAGNOSTIC_TITLE = "Decisions setup check · runs no agent";

/** The one resource a diagnostic terminal's question may attach. */
export const SETUP_CHECK_IMAGE_ID = "setup-check.png";

/** A 16 by 16 checkerboard PNG: the image the setup check sends to the relay and back. */
export const SETUP_CHECK_IMAGE: Uint8Array = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJElEQVR42mPQz/eHoxcfXsERLnGGQaiBGEXI4oNRw2g8DAoNABhe15A83/ZgAAAAAElFTkSuQmCC",
    "base64"
  )
);

/** What a diagnostic terminal keeps of what was typed; the test answer is a few hundred bytes. */
const MAX_SCREEN_CHARS = 32 * 1024;

export function isSetupDiagnosticPane(paneId: string): boolean {
  return paneId.startsWith(SETUP_DIAGNOSTIC_PANE_PREFIX);
}

/** One answer the diagnostic terminal took, as typed. */
export interface SetupDiagnosticTyping {
  questionId: string;
  revision: number;
  source: "human" | "proxy" | "system";
  expired: boolean;
  injectionId: string;
  text: string;
}

function sameAsker(a: PaneIdentity, b: PaneIdentity): boolean {
  return (
    a.host_id === b.host_id &&
    a.pane_id === b.pane_id &&
    a.terminal_generation === b.terminal_generation &&
    a.ownership_principal === b.ownership_principal &&
    a.agent_incarnation === b.agent_incarnation &&
    a.agent_session_id === b.agent_session_id &&
    a.worktree_id === b.worktree_id
  );
}

/**
 * The terminal a setup check's answer is typed into (#16024). It runs no
 * agent and no process: what delivery types is kept as its screen and shown
 * in Settings, so a typed line can never run as a command. It has a run
 * identity of its own, made here and never an agent's, so delivery's exact
 * match keeps every other answer out of it and this one out of every pane.
 */
export class SetupDiagnosticTerminal {
  readonly origin: QuestionOrigin;
  private text = "";
  private open = true;
  private expected: string | null = null;
  private readonly typings: SetupDiagnosticTyping[] = [];

  constructor(
    hostId: string,
    private readonly onChange: () => void
  ) {
    const id = randomBytes(12).toString("hex");
    this.origin = {
      host_id: hostId,
      pane_id: `${SETUP_DIAGNOSTIC_PANE_PREFIX}${id}`,
      terminal_generation: 1,
      ownership_principal: `setup-check-${id}`,
      agent_incarnation: "none",
      agent_kind: "setup-check",
      agent_session_id: null,
      project_id: "daintree-setup-check",
      worktree_id: "setup-check",
      worktree_root: "",
      workflow_gate_id: null,
      project_label: "Daintree setup check",
      machine_label: hostname(),
    };
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** What Settings shows, while open. */
  view(): DecisionsSetupDiagnosticTerminal | null {
    return this.open ? { title: SETUP_DIAGNOSTIC_TITLE, screen: this.text } : null;
  }

  /** The question whose answers it takes; any other is refused. */
  expect(questionId: string): void {
    this.expected = questionId;
  }

  matches(target: TerminalTarget): boolean {
    return this.open && sameTarget(targetOf(this.origin), target);
  }

  isAsker(pane: PaneIdentity): boolean {
    return this.open && sameAsker(paneIdentityOf(this.origin), pane);
  }

  /** A person's answer to `questionId`, once one has been typed; never an expiry notice or a proxy's. */
  answerTypedFor(questionId: string): SetupDiagnosticTyping | undefined {
    return this.typings.find(
      (typing) => typing.questionId === questionId && typing.source === "human" && !typing.expired
    );
  }

  hasMarker(injectionId: string): boolean {
    return this.text.includes(injectionId);
  }

  /** Types the library's notice as Daintree renders it for a terminal, or refuses it whole. */
  type(text: string, injectionId: string): InjectResult {
    const blocks = parseAnswerNotice(text);
    if (
      blocks === null ||
      blocks[0].injectionId !== injectionId ||
      this.expected === null ||
      blocks.some((block) => block.questionId !== this.expected)
    ) {
      return { outcome: "unavailable", reason: "rejected", detail: "invalid-notice" };
    }
    const typed = renderDecisionSection(blocks);
    const next = this.text === "" ? typed : `${this.text}\n${typed}`;
    this.text = next.length > MAX_SCREEN_CHARS ? next.slice(-MAX_SCREEN_CHARS) : next;
    for (const block of blocks) {
      this.typings.push({
        questionId: block.questionId,
        revision: block.revision,
        source: block.source,
        expired: block.expired,
        injectionId: block.injectionId,
        text: typed,
      });
    }
    this.onChange();
    return { outcome: "delivered", proof: `setup-diagnostic:${injectionId}` };
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.text = "";
    this.onChange();
  }
}

/**
 * The setup check's diagnostic terminals, for the rest of Decisions to route
 * by: at most one is open at a time. Delivery hands every diagnostic pane id
 * to `sink`, never to the agent sink, and attachments ask `attachmentResolver`
 * first, so a diagnostic origin only ever reaches its own terminal and image.
 */
export class SetupDiagnostics {
  private current: SetupDiagnosticTerminal | null = null;

  readonly sink: TerminalSink = {
    locate: async (origin: QuestionOrigin): Promise<LocateResult> => {
      const target = targetOf(origin);
      return this.current?.matches(target) ? { state: "alive", target } : { state: "gone" };
    },
    isIdle: async (target) => this.current?.matches(target) === true,
    inject: async (target, text, injectionId) => {
      const terminal = this.current;
      if (!terminal?.matches(target)) return { outcome: "unavailable", reason: "gone" };
      return terminal.type(text, injectionId);
    },
    hasMarker: async (target, injectionId) =>
      this.current?.matches(target) === true && this.current.hasMarker(injectionId),
  };

  /** Opens a fresh diagnostic terminal, closing the one before it. */
  open(hostId: string, onChange: () => void): SetupDiagnosticTerminal {
    this.current?.close();
    const terminal = new SetupDiagnosticTerminal(hostId, onChange);
    this.current = terminal;
    return terminal;
  }

  /** Closes `terminal`, if it is the one open. */
  close(terminal: SetupDiagnosticTerminal): void {
    terminal.close();
    if (this.current === terminal) this.current = null;
  }

  handles(paneId: string): boolean {
    return isSetupDiagnosticPane(paneId);
  }

  /** Whether `pane` is the open diagnostic terminal's own identity. */
  isCurrent(pane: PaneIdentity): boolean {
    return this.current?.isAsker(pane) === true;
  }

  /** `fallback` for every other origin; a diagnostic origin gets its own image or nothing. */
  attachmentResolver(fallback: AttachmentResolver): AttachmentResolver {
    return {
      resolve: async (origin, localResourceId) => {
        if (!this.handles(origin.pane_id)) return fallback.resolve(origin, localResourceId);
        if (localResourceId !== SETUP_CHECK_IMAGE_ID) return null;
        if (!this.isCurrent(paneIdentityOf(origin))) return null;
        return { bytes: new Uint8Array(SETUP_CHECK_IMAGE) };
      },
    };
  }
}
