/**
 * Turns the references a model actually writes into things you can click.
 *
 * ## Why a remark (mdast) transform rather than a rehype one
 *
 * At mdast the tree still distinguishes `inlineCode` from `code`: a backticked span and
 * a fenced block are different node types, and a fenced block carries its content as a
 * `value` with no children, so a walk over children cannot reach into it by accident.
 * By hast both are `<code>` and telling them apart means inspecting `<pre>` ancestry —
 * rediscovering, less reliably, something the earlier tree stated outright.
 *
 * It also keeps everything inside the renderer's existing safety boundary. No raw HTML
 * is parsed and nothing is rewritten at the source-text level, which would fire inside
 * fences and indented blocks where the characters are meant to be literal.
 *
 * ## What is recognised, and what is deliberately not
 *
 * The policy is asymmetric on purpose. A reference that fails to become a link costs a
 * reader one copy-paste. A wrong link costs them their trust in every other link in the
 * transcript, and they cannot tell which ones to doubt. So this only fires where the
 * model has said what it means:
 *
 *   `PR #11250`, `pull request #11250`  → the pull request
 *   `issue #11244`                      → the issue
 *   `` `#11244` `` after "issue"/"PR"   → same, reading only the adjacent word
 *   `` `https://…` ``                   → external, the one thing a URL can be
 *
 * and specifically NOT:
 *
 *   bare `#5167`     — issue, pull request, heading anchor, or a number someone wrote.
 *                      GitHub itself resolves `#N` only inside a repository context
 *                      this panel does not always have.
 *   `@gregpriday`    — no provider-neutral "open this account" action exists, and the
 *                      panel is not entitled to guess a forge's profile URL.
 *   dotted tokens    — `forge.assignIssue` is a tool id, `package.json` is a file,
 *                      `127.0.0.1` is a host, and nothing in the text says which.
 *
 * Bare `http(s)://` in ORDINARY prose is already handled upstream by remark-gfm's
 * autolink literals, which is why this runs after it and never re-links what it made.
 *
 * ## A stated limitation: recognition is text-node-local
 *
 * A reference broken across formatting — `See PR **#123**`, or `**PR** #123` — is three
 * mdast nodes, and no single one of them contains the whole pattern, so none of them
 * matches. Those stay plain text.
 *
 * That is a deliberate stopping point rather than an oversight. Matching across sibling
 * nodes means deciding what counts as adjacent when a link, a code span or an image
 * sits between them, and getting that wrong produces a link whose label spans elements
 * the author never meant to join. The common shape a model actually writes — a bare
 * `PR #123`, or a backticked `` `#123` `` after the word — is covered, and the rest is
 * left plain rather than guessed at.
 */

export interface ReferenceCapabilities {
  /**
   * Whether a forge provider actually resolved for this project.
   *
   * Without one there is nowhere for an issue reference to go — and constructing a
   * github.com URL from the remote would be this panel deciding which forge a project
   * uses, which is precisely the assumption the forge abstraction exists to remove.
   * References stay plain text instead.
   */
  forge: boolean;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

/** `PR #123`, `pull request #123`, `issue #123` — the number attached to its own noun. */
const EXPLICIT_REF = /\b(pull requests?|prs?|issues?)\s+#(\d{1,7})\b/gi;

/** A backticked `#123`, which only becomes a link if the word before it says what it is. */
const BARE_NUMBER = /^#(\d{1,7})$/;

/** What the word immediately before a backticked `#123` has to be for it to count. */
const TRAILING_NOUN = /\b(pull requests?|prs?|issues?)\s*$/i;

/**
 * A whole inline-code span that is nothing but an absolute http(s) URL.
 *
 * Anchored at both ends deliberately: a span reading `curl https://x/y -H ...` is a
 * command, and linking the command would be linking something the reader is meant to
 * run rather than follow.
 */
const WHOLE_URL = /^https?:\/\/[^\s`<>"']+$/i;

function isPullNoun(noun: string): boolean {
  return /^(pull requests?|prs?)$/i.test(noun);
}

/** The reference kinds a click can act on. Mirrored by `AssistantMessage`'s `a` override. */
export type ReferenceKind = "issue" | "pr";

const REFERENCE_KINDS: readonly string[] = ["issue", "pr"];

/**
 * Narrows a rendered `data-ref-kind` back to a kind.
 *
 * Checked rather than asserted. The value makes a round trip through a DOM attribute,
 * so by the time the click handler reads it back the type system knows nothing about
 * it — and a cast would let a future kind added here reach a dispatch that has no case
 * for it, silently, at runtime. This is the seam where that has to be re-established.
 */
export function isReferenceKind(value: unknown): value is ReferenceKind {
  return typeof value === "string" && REFERENCE_KINDS.includes(value);
}

function forgeLink(kind: ReferenceKind, number: string, label: string): MdNode {
  return {
    type: "link",
    // No URL. A forge reference is resolved by the host at CLICK time, through the
    // registered provider — it is not a web address this renderer is entitled to
    // guess, and leaving it empty means nothing can navigate even if a handler is
    // missing. The kind and number travel as data attributes instead.
    url: "",
    data: {
      hName: "a",
      hProperties: { "data-ref-kind": kind, "data-ref-number": number },
    },
    children: [{ type: "text", value: label }],
  };
}

/**
 * Rewrites one text node into the run of nodes its explicit references imply.
 * Returns `null` when nothing matched, so the caller can keep the original node.
 */
function splitExplicitRefs(value: string, caps: ReferenceCapabilities): MdNode[] | null {
  if (!caps.forge) return null;
  EXPLICIT_REF.lastIndex = 0;
  let match = EXPLICIT_REF.exec(value);
  if (match === null) return null;

  const out: MdNode[] = [];
  let cursor = 0;
  while (match !== null) {
    const [whole, noun, number] = match;
    if (match.index > cursor) {
      out.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    out.push(forgeLink(isPullNoun(noun!) ? "pr" : "issue", number!, whole));
    cursor = match.index + whole.length;
    match = EXPLICIT_REF.exec(value);
  }
  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
  return out;
}

function transform(node: MdNode, caps: ReferenceCapabilities): void {
  const children = node.children;
  if (!children) return;

  // A link's own label is never re-scanned. Nesting an anchor inside an anchor is
  // invalid HTML, and the outer link is the one the author meant.
  if (node.type === "link" || node.type === "linkReference") return;

  const next: MdNode[] = [];
  for (const child of children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const value = child.value;

      if (WHOLE_URL.test(value)) {
        // The span keeps its code styling INSIDE the link, so it still reads as the
        // literal it is — the anchor adds the affordance without taking the kind away.
        next.push({ type: "link", url: value, children: [{ ...child }] });
        continue;
      }

      const bare = BARE_NUMBER.exec(value);
      if (bare !== null && caps.forge) {
        // The only context read is the text immediately before it. Anything wider —
        // scanning the sentence, or the paragraph — starts inferring, and a reference
        // that resolves differently depending on how far back a word appeared is worse
        // than one that never resolves.
        const prev = next[next.length - 1];
        const noun =
          prev?.type === "text" && typeof prev.value === "string"
            ? TRAILING_NOUN.exec(prev.value)
            : null;
        if (noun !== null) {
          next.push(forgeLink(isPullNoun(noun[1]!) ? "pr" : "issue", bare[1]!, value));
          continue;
        }
      }

      next.push(child);
      continue;
    }

    if (child.type === "text" && typeof child.value === "string") {
      const split = splitExplicitRefs(child.value, caps);
      if (split !== null) {
        next.push(...split);
        continue;
      }
      next.push(child);
      continue;
    }

    transform(child, caps);
    next.push(child);
  }
  node.children = next;
}

/**
 * The plugin factory. Must run AFTER `remark-gfm` (so autolink literals in prose are
 * already links and are skipped here) and BEFORE the soft-break transform (which splits
 * text nodes on newlines and would fragment nothing this matches, but keeps the reading
 * order of the pipeline honest: recognise, then lay out).
 */
export function remarkReferences(caps: ReferenceCapabilities) {
  return () => (tree: MdNode) => transform(tree, caps);
}
