import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import type {
  EditOperation,
  EditReceipt,
  SiteEditErrorCode,
  SourceRange,
} from "../shared/model.js";
import type { EditApplyArgs, EditApplyResult } from "../shared/protocol.js";
import type {
  MutationFailureReason,
  MutationPlan,
  Replacement,
  ResolvedElement,
  SurfaceSupport,
  SvelteAstNode,
  SvelteAstRoot,
  SvelteParse,
} from "@daintreehq/svelte-source-model";
import { loadParse, loadSourceModel, type SourceModel } from "./engine.js";
import { changedRange, type KeyedLock } from "./journal.js";
import {
  containsRealPath,
  isGeneratedPath,
  MAX_SOURCE_BYTES,
  offsetToLocation,
  readSource,
  resolveWorktreePath,
  sha256Hex,
} from "./source.js";
import {
  MAX_REMEMBERED_EDITS,
  MAX_REMEMBERED_REVERSALS,
  trimOldest,
  type Workspace,
} from "./workspace.js";

type ErrorResult = { status: "error"; code: SiteEditErrorCode; message: string };

function fail(code: SiteEditErrorCode, message: string): ErrorResult {
  return { status: "error", code, message };
}

export type EditUndoResult =
  | { status: "reversed"; receipt: EditReceipt }
  | { status: "superseded"; currentRevision: string }
  | ErrorResult;

const REVISION = /^[0-9a-f]{64}$/;

function messageOf(error: unknown): string {
  return formatErrorMessage(error, "source edit failed");
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  // Across the worker port only the message survives, prefixed with the code.
  return /^([A-Z_]+):/.exec(messageOf(error))?.[1] ?? "";
}

function writeFailure(error: unknown): ErrorResult {
  const code = codeOf(error);
  const message = messageOf(error) || "write failed";
  switch (code) {
    case "PERMISSION_REQUIRED":
      return fail("PERMISSION_REQUIRED", message);
    case "PATH_NOT_ALLOWED":
    case "TARGET_IS_SYMLINK":
      return fail("OUT_OF_SCOPE", message);
    case "TARGET_UNAVAILABLE":
      return fail("STALE_SOURCE", message);
    default:
      return fail("WRITER_BUSY", message);
  }
}

type WriteOutcome =
  | { status: "written"; revision: string }
  | { status: "mismatch"; currentRevision: string | null }
  | ErrorResult;

/**
 * The single write path. `expectedRevision` makes it a compare-and-swap in the
 * host, so nothing here can overwrite bytes it has not seen — including a
 * retry of a write that already landed, which now mismatches.
 */
async function writeChecked(
  workspace: Workspace,
  absolutePath: string,
  worktreeRelative: string,
  contents: string,
  expectedRevision: string
): Promise<WriteOutcome> {
  const planned = sha256Hex(contents);
  workspace.tracker.beginWrite(absolutePath, worktreeRelative, planned);
  let written: string | null = null;
  try {
    const result = await workspace.fs.writeFile(absolutePath, contents, { expectedRevision });
    written = result.revision;
    return { status: "written", revision: result.revision };
  } catch (error) {
    if (codeOf(error) === "REVISION_MISMATCH") {
      const reported = (error as { currentRevision?: unknown }).currentRevision;
      if (typeof reported === "string" && REVISION.test(reported)) {
        return { status: "mismatch", currentRevision: reported };
      }
      const current = await readSource(workspace.fs, absolutePath);
      return {
        status: "mismatch",
        currentRevision: "revision" in current ? current.revision : null,
      };
    }
    // Matching bytes on disk would not prove this write put them there — another
    // writer may have — so a rejection stays a failure and the journal records
    // nothing. The tracker's recheck reports whatever is on disk now.
    return writeFailure(error);
  } finally {
    workspace.tracker.endWrite(absolutePath, planned, written);
  }
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Start offsets of every node that encloses `range`, innermost first. */
function enclosingStarts(ast: SvelteAstRoot, range: SourceRange): number[] {
  const starts = new Set<number>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Partial<SvelteAstNode>;
    if (
      typeof node.type === "string" &&
      typeof node.start === "number" &&
      typeof node.end === "number"
    ) {
      if (node.start > range.start || node.end < range.end) return;
      starts.add(node.start);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent") visit(child);
    }
  };
  visit(ast.fragment);
  return [...starts].sort((a, b) => b - a);
}

function surfaceOf(element: ResolvedElement, operation: EditOperation): SurfaceSupport | undefined {
  switch (operation.kind) {
    case "set_literal_text":
      return element.text;
    case "set_class_tokens":
      return element.classes;
    case "set_literal_attribute":
      return element.attributes[operation.name];
    case "set_literal_prop":
      return element.props[operation.name];
  }
}

/**
 * The element an operation addresses. The operation carries a range, and the
 * range is re-derived from current source rather than trusted: it must be
 * exactly the operation's surface range, or exactly the element's own range
 * (what a selection's `definition.range` gives the view). Anything else —
 * including a range that merely overlaps — is not found.
 */
function findOwner(
  model: SourceModel,
  source: string,
  file: string,
  ast: SvelteAstRoot,
  parse: SvelteParse,
  operation: EditOperation
): ResolvedElement | null {
  if (operation.range.end > source.length) return null;
  for (const start of enclosingStarts(ast, operation.range)) {
    const location = { file, ...offsetToLocation(source, start) };
    const resolved = model.resolveElementAtLocation(source, location, parse);
    if (resolved.status !== "resolved") continue;
    const element = resolved.node;
    if (sameRange(element.range, operation.range)) return element;
    const surface = surfaceOf(element, operation);
    if (surface?.support === "direct" && sameRange(surface.range, operation.range)) return element;
  }
  return null;
}

const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "srcset",
  "xlink:href",
  "cite",
  "background",
]);

/**
 * The planner writes any literal attribute correctly; whether it *should* is a
 * policy it does not own. Inline handlers are code, and a URL attribute is
 * code too once it carries a script scheme.
 */
function attributePolicy(name: string, value: string | number | boolean): ErrorResult | null {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) {
    return fail("UNSUPPORTED_ATTRIBUTE", `${name} is an event handler, not a literal value`);
  }
  if (URL_ATTRIBUTES.has(lower) && typeof value === "string") {
    // Browsers ignore ASCII whitespace and control characters inside a scheme.
    const scheme = [...value]
      .filter((char) => char.charCodeAt(0) > 0x20 && char.charCodeAt(0) !== 0x7f)
      .join("")
      .toLowerCase();
    if (
      scheme.startsWith("javascript:") ||
      scheme.startsWith("vbscript:") ||
      (scheme.startsWith("data:") && !/^data:image\/(?!svg)/.test(scheme))
    ) {
      return fail("UNSUPPORTED_ATTRIBUTE", `${name} may not use that URL scheme`);
    }
  }
  return null;
}

/**
 * A range intent is a promise about where the edit applies. Every added token
 * must carry that variant chain, or "edit at md and up" silently becomes an
 * edit at every width.
 */
function responsivePolicy(operation: Extract<EditOperation, { kind: "set_class_tokens" }>) {
  if (operation.responsive.kind !== "range") return null;
  const wanted = operation.responsive.variant.split(":");
  for (const token of operation.add) {
    const chain = token.split(":").slice(0, -1);
    const carries = chain.some((_, index) =>
      wanted.every((variant, offset) => chain[index + offset] === variant)
    );
    if (!carries) {
      return fail(
        "INVALID_CANDIDATE",
        `${token} does not carry the ${operation.responsive.variant} variant this edit targets`
      );
    }
  }
  return null;
}

function refusal(reason: MutationFailureReason, detail: string | undefined): ErrorResult {
  const message = detail ? `${reason}: ${detail}` : reason;
  switch (reason) {
    case "invalid-class-token":
    case "token-not-writable-literally":
      return fail("INVALID_CANDIDATE", message);
    case "invalid-attribute-value":
      return fail("UNSUPPORTED_ATTRIBUTE", message);
    case "candidate-parse-failed":
      return fail("PARSE_FAILED", message);
    default:
      return fail("UNSUPPORTED_EXPRESSION", message);
  }
}

function planOperation(
  model: SourceModel,
  source: string,
  element: ResolvedElement,
  operation: EditOperation
): MutationPlan | ErrorResult {
  switch (operation.kind) {
    case "set_literal_text":
      return model.planSetLiteralText(source, element, operation.text);
    case "set_class_tokens": {
      if (element.hasSpread) {
        return fail("UNSUPPORTED_EXPRESSION", "a spread on this element can override its classes");
      }
      const policy = responsivePolicy(operation);
      if (policy) return policy;
      return model.planSetClassTokens(source, element, {
        add: operation.add,
        remove: operation.remove,
      });
    }
    case "set_literal_attribute": {
      if (element.hasSpread) {
        return fail(
          "UNSUPPORTED_EXPRESSION",
          "a spread on this element can override its attributes"
        );
      }
      const policy = attributePolicy(operation.name, operation.value);
      if (policy) return policy;
      return model.planSetLiteralAttribute(source, element, operation.name, operation.value);
    }
    case "set_literal_prop": {
      const policy = attributePolicy(operation.name, operation.value);
      if (policy) return policy;
      return model.planSetLiteralProp(source, element, operation.name, operation.value);
    }
  }
}

function complementOf(length: number, replacements: readonly Replacement[]): SourceRange[] {
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  const ranges: SourceRange[] = [];
  let cursor = 0;
  for (const replacement of sorted) {
    if (replacement.start > cursor) ranges.push({ start: cursor, end: replacement.start });
    cursor = Math.max(cursor, replacement.end);
  }
  if (cursor < length) ranges.push({ start: cursor, end: length });
  return ranges;
}

type Candidate = { status: "planned"; after: string } | { status: "no-op" } | ErrorResult;

async function planCandidate(
  model: SourceModel,
  source: string,
  appRelative: string,
  operations: readonly EditOperation[]
): Promise<Candidate> {
  const parse = await loadParse();
  let ast: SvelteAstRoot;
  try {
    ast = parse(source, { modern: true, filename: appRelative });
  } catch (error) {
    return fail("PARSE_FAILED", messageOf(error));
  }
  // Each resolve re-parses; the source does not change between them, so one
  // AST serves every lookup.
  const cachedParse: SvelteParse = (text, options) =>
    text === source ? ast : parse(text, options);

  // Every operation plans against the original bytes, so their ranges agree
  // with the view's and the replacements compose in one splice.
  const replacements: Replacement[] = [];
  for (const operation of operations) {
    const element = findOwner(model, source, appRelative, ast, cachedParse, operation);
    if (!element) {
      return fail(
        "NODE_NOT_FOUND",
        `no element owns ${operation.range.start}-${operation.range.end}`
      );
    }
    const plan = planOperation(model, source, element, operation);
    if (plan.status === "error") return plan;
    if (plan.status === "refused") {
      if (plan.reason === "no-op") continue;
      return refusal(plan.reason, plan.detail);
    }
    replacements.push(...plan.replacements);
  }
  if (replacements.length === 0) return { status: "no-op" };

  // Splicing accepts two insertions at one offset and concatenates them —
  // `class=""` gaining `p-2` and `font-bold` as `p-2font-bold`. Two operations
  // on one slot are a conflict, not a composition.
  const ordered = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.start < previous.end || current.start === previous.start) {
      return fail("UNSUPPORTED_EXPRESSION", "two operations target the same source range");
    }
  }

  let after: string;
  try {
    after = model.applyReplacements(source, replacements);
  } catch (error) {
    return fail("UNSUPPORTED_EXPRESSION", `operations overlap: ${messageOf(error)}`);
  }
  if (after === source) return { status: "no-op" };

  // Each plan already proved its own complement untouched. The verifier treats
  // the span from first to last difference as one edit, so for several
  // disjoint replacements the gaps between them would read as modified; the
  // combined candidate is then only re-parsed.
  const verdict = model.verifyCandidate(
    source,
    after,
    replacements.length === 1 ? complementOf(source.length, replacements) : [],
    parse
  );
  if (!verdict.ok) {
    if (verdict.reason === "no-op") return { status: "no-op" };
    return refusal(verdict.reason, verdict.detail);
  }
  return { status: "planned", after };
}

/* -------------------------------------------------------------------------- */
/* Apply and undo                                                             */
/* -------------------------------------------------------------------------- */

async function performEdit(
  workspace: Workspace,
  args: EditApplyArgs,
  lock: KeyedLock
): Promise<EditApplyResult> {
  if (workspace.support.level !== "full") {
    return fail("UNSUPPORTED_EXPRESSION", "this app's installed toolchain is preview-only");
  }
  const target = resolveWorktreePath(workspace, args.file);
  if (!target.ok || !(await containsRealPath(workspace.appRoot, target.absolute))) {
    return fail("OUT_OF_SCOPE", `${args.file} is not inside the app`);
  }
  const model = await loadSourceModel();
  if (isGeneratedPath(model.isGeneratedSourceFile, target.appRelative)) {
    return fail("GENERATED_FILE", `${args.file} is generated`);
  }
  if (!target.appRelative.endsWith(".svelte")) {
    return fail("OUT_OF_SCOPE", `${args.file} is not a Svelte component`);
  }

  return lock.run(target.absolute, async (): Promise<EditApplyResult> => {
    const read = await readSource(workspace.fs, target.absolute);
    if (read.status === "missing") return fail("STALE_SOURCE", `${args.file} is unavailable`);
    if (read.status === "too-large") return fail("OUT_OF_SCOPE", `${args.file} is too large`);
    // Revision first, before anything is planned: a plan against bytes the
    // caller has not seen would be an edit at stale offsets.
    if (read.revision !== args.expectedRevision) {
      return { status: "conflict", currentRevision: read.revision };
    }
    if (read.status === "not-utf8") return fail("PARSE_FAILED", `${args.file} is not UTF-8`);
    workspace.tracker.observe(target.absolute, target.worktreeRelative, read.revision);

    const candidate = await planCandidate(model, read.text, target.appRelative, args.operations);
    if (candidate.status !== "planned") return candidate;
    // Every read refuses files over the cap, so an edit that crosses it would
    // be saved and then impossible to undo or edit again.
    if (Buffer.byteLength(candidate.after, "utf8") > MAX_SOURCE_BYTES) {
      return fail("OUT_OF_SCOPE", `the edit would grow ${args.file} past the editable size`);
    }

    const write = await writeChecked(
      workspace,
      target.absolute,
      target.worktreeRelative,
      candidate.after,
      read.revision
    );
    if (write.status === "error") return write;
    if (write.status === "mismatch") {
      if (write.currentRevision === null)
        return fail("STALE_SOURCE", `${args.file} is unavailable`);
      return { status: "conflict", currentRevision: write.currentRevision };
    }

    const transactionId = randomUUID();
    workspace.journal.record({
      transactionId,
      absolutePath: target.absolute,
      worktreeRelative: target.worktreeRelative,
      before: read.text,
      after: candidate.after,
      beforeRevision: read.revision,
      afterRevision: write.revision,
      affectedOccurrences: args.affectedOccurrences,
    });
    return {
      status: "applied",
      receipt: {
        transactionId,
        file: target.worktreeRelative,
        beforeRevision: read.revision,
        afterRevision: write.revision,
        appliedRange: changedRange(read.text, candidate.after),
        sourceSaved: true,
        // Main can observe neither; the view proves them from the guest.
        previewRefreshed: null,
        stylesGenerated: null,
        affectedOccurrences: args.affectedOccurrences,
        appliedAt: new Date().toISOString(),
      },
    };
  });
}

/**
 * Applies an edit at most once per idempotency key. The outcome is remembered
 * as a promise, so a retry that lands while the first attempt is still writing
 * joins it rather than racing it. A key reused for a different edit is a
 * caller bug and is refused rather than answered with an unrelated receipt.
 */
/**
 * Evicts only settled outcomes, oldest first. An in-flight edit's key must
 * stay joinable; a settled key past the bound can be retried, and the revision
 * check then refuses it unless the file has returned to its original bytes.
 */
function trimSettledEdits(workspace: Workspace): void {
  for (const [key, entry] of workspace.edits) {
    if (workspace.edits.size <= MAX_REMEMBERED_EDITS) return;
    if (entry.settled) workspace.edits.delete(key);
  }
}

export function applyEdit(
  workspace: Workspace,
  args: EditApplyArgs,
  lock: KeyedLock
): Promise<EditApplyResult> {
  // Args arrive schema-parsed, so key order is the schema's and stable.
  const fingerprint = JSON.stringify([
    args.file,
    args.expectedRevision,
    args.operations,
    args.affectedOccurrences,
  ]);
  const remembered = workspace.edits.get(args.idempotencyKey);
  if (remembered) {
    if (remembered.fingerprint !== fingerprint) {
      return Promise.resolve(
        fail("WRITER_BUSY", "this idempotency key already belongs to a different edit")
      );
    }
    return remembered.outcome;
  }

  const outcome = performEdit(workspace, args, lock);
  const record = { fingerprint, outcome, settled: false };
  workspace.edits.set(args.idempotencyKey, record);
  void outcome.then(
    () => {
      record.settled = true;
    },
    () => {
      record.settled = true;
    }
  );
  trimSettledEdits(workspace);
  // A thrown handler wrote nothing the journal knows of; forgetting the key
  // lets a retry run again, and the revision check keeps that retry honest.
  outcome.catch(() => {
    if (workspace.edits.get(args.idempotencyKey)?.outcome === outcome) {
      workspace.edits.delete(args.idempotencyKey);
    }
  });
  return outcome;
}

/**
 * Writes a transaction's before-bytes back, but only over its own after-bytes.
 * Any other content — a later builder edit, an agent, the user's editor — means
 * the file has moved on, and reversing it is a review, not a blind write.
 */
export async function undoEdit(
  workspace: Workspace,
  transactionId: string,
  lock: KeyedLock
): Promise<EditUndoResult> {
  const initial = workspace.journal.get(transactionId);
  if (!initial) {
    const reversed = workspace.reversals.get(transactionId);
    if (reversed) return { status: "reversed", receipt: reversed };
    return fail("NODE_NOT_FOUND", "that edit is no longer in the undo history");
  }

  return lock.run(initial.absolutePath, async (): Promise<EditUndoResult> => {
    const reversed = workspace.reversals.get(transactionId);
    if (reversed) return { status: "reversed", receipt: reversed };
    const entry = workspace.journal.get(transactionId);
    if (!entry) return fail("NODE_NOT_FOUND", "that edit is no longer in the undo history");

    const current = await readSource(workspace.fs, entry.absolutePath);
    if (current.status === "missing") {
      return fail("STALE_SOURCE", `${entry.worktreeRelative} is unavailable`);
    }
    if (!("revision" in current)) {
      return fail("OUT_OF_SCOPE", `${entry.worktreeRelative} is too large`);
    }
    if (current.revision !== entry.afterRevision) {
      return { status: "superseded", currentRevision: current.revision };
    }

    const write = await writeChecked(
      workspace,
      entry.absolutePath,
      entry.worktreeRelative,
      entry.before,
      entry.afterRevision
    );
    if (write.status === "error") return write;
    if (write.status === "mismatch") {
      if (write.currentRevision === null) {
        return fail("STALE_SOURCE", `${entry.worktreeRelative} is unavailable`);
      }
      return { status: "superseded", currentRevision: write.currentRevision };
    }

    // The reversal is itself journalled, so undoing it is a redo with exactly
    // the same revision discipline.
    const inverseId = randomUUID();
    workspace.journal.delete(transactionId);
    workspace.journal.record({
      transactionId: inverseId,
      absolutePath: entry.absolutePath,
      worktreeRelative: entry.worktreeRelative,
      before: entry.after,
      after: entry.before,
      beforeRevision: entry.afterRevision,
      afterRevision: write.revision,
      affectedOccurrences: entry.affectedOccurrences,
    });
    const receipt: EditReceipt = {
      transactionId: inverseId,
      file: entry.worktreeRelative,
      beforeRevision: entry.afterRevision,
      afterRevision: write.revision,
      appliedRange: changedRange(entry.after, entry.before),
      sourceSaved: true,
      previewRefreshed: null,
      stylesGenerated: null,
      affectedOccurrences: entry.affectedOccurrences,
      appliedAt: new Date().toISOString(),
    };
    workspace.reversals.set(transactionId, receipt);
    trimOldest(workspace.reversals, MAX_REMEMBERED_REVERSALS);
    return { status: "reversed", receipt };
  });
}
