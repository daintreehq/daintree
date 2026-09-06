import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode } from "@/components/Markdown/HighlightedCode";
import { isReferenceKind, remarkReferences, type ReferenceKind } from "./remarkReferences";
import { AssistantLink } from "./AssistantLink";
import { cn } from "@/lib/utils";

/**
 * Streaming-safe markdown for one assistant message.
 *
 * ## Why the memo boundary matters here
 *
 * Markdown parsing is O(n) in the accumulated text, and a streaming turn re-renders
 * on every token. Parsing the whole buffer per token is therefore O(n²) over a turn,
 * which is invisible on a two-line answer and very visible on a long one — the
 * classic streaming-chat performance failure.
 *
 * Two things keep that in check. This component is memoized on `content`, so a token
 * that lands in one message never re-parses another. And the transcript hands
 * streaming text through a frame-coalescing buffer, so the parse runs at most once
 * per animation frame rather than once per token.
 *
 * ## Why not `MarkdownDocument`
 *
 * That component resolves relative links and images against a file path and root, so
 * a rendered file's `![](./diagram.png)` loads. An assistant message has no such
 * base: its links are absolute, and giving it a fake root would let a model-authored
 * relative path resolve into the user's project. This renderer deliberately handles
 * less.
 */

/** A reference the reader clicked, for the panel's owner to route. */
export interface AssistantReference {
  kind: ReferenceKind;
  number: number;
}

export interface AssistantMessageProps {
  content: string;
  /** Renders the streaming caret. */
  streaming?: boolean;
  /**
   * Routes a click on an internal reference. This component stays presentational and
   * holds no dispatch of its own — the owner decides what "open issue 11244" means,
   * because that depends on the project and the resolved forge provider, neither of
   * which a message knows about.
   *
   * MUST be referentially stable. It is a prop of a memoized component that re-renders
   * on every frame of a streaming turn, so a fresh closure per render would defeat the
   * memo boundary this file exists to protect.
   */
  onActivateReference?: (reference: AssistantReference) => void;
  /**
   * Whether a forge provider resolved for this project.
   *
   * Gates recognition, not just routing: with no provider there is no destination, and
   * a reference rendered as a link that cannot go anywhere is a broken promise. It
   * stays plain text.
   */
  forgeAvailable?: boolean;
  className?: string;
}

/**
 * A single newline is a LINE BREAK, as it was in the terminal.
 *
 * CommonMark folds a lone `\n` into a space, so a model that writes its status as
 * several one-line statements arrives as one running paragraph. The cockpit did the
 * opposite — it wrapped each source line independently, "so existing newlines
 * (paragraphs, list items) are preserved" (internal/ui/markdown/markdown.go:207) — so
 * a terminal reader saw exactly the line structure the model wrote. Collapsing it here
 * is not a neutral rendering choice; it destroys information the model sent, and it is
 * why the transcript reads as slammed together.
 *
 * Done as an mdast transform rather than by rewriting the source text, because the
 * source-level trick (two trailing spaces) would also fire inside fenced code and
 * indented blocks, where a newline is already literal. Walking the tree touches only
 * `text` nodes, and `code`/`inlineCode` carry their content as a value with no
 * children, so they are structurally out of reach.
 *
 * Written against the tree directly instead of importing `unist-util-visit`: that
 * package is present only as a transitive dependency of react-markdown, and this repo's
 * node_modules is a symlink shared with the main checkout, so declaring a new dependency
 * for twenty lines is not worth what installing it would touch.
 */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

function splitTextNodes(node: MdastNode): void {
  const children = node.children;
  if (!children) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
      const parts = child.value.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) next.push({ type: "break" });
        // An empty part is the gap between two adjacent newlines; the breaks around it
        // already carry it, and an empty text node would render as nothing anyway.
        if (parts[i] !== "") next.push({ type: "text", value: parts[i] });
      }
    } else {
      splitTextNodes(child);
      next.push(child);
    }
  }
  node.children = next;
}

function remarkSoftBreaks() {
  return (tree: MdastNode) => splitTextNodes(tree);
}

/**
 * Trailing-fence repair.
 *
 * A code fence arrives as ``` then a language then content — so mid-stream there is a
 * window where the opening fence has landed and the closing one has not. react-markdown
 * renders that as a fence swallowing the rest of the message, which makes the text
 * visibly lurch when the closing fence finally arrives. Closing it optimistically
 * keeps the block stable while it fills in.
 */
function balanceFences(text: string): string {
  const fences = text.match(/^```/gm);
  if (fences && fences.length % 2 === 1) return `${text}\n\`\`\``;
  return text;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  streaming = false,
  onActivateReference,
  forgeAvailable = false,
  className,
}: AssistantMessageProps) {
  const source = useMemo(() => balanceFences(content), [content]);

  // Rebuilt only when the capability actually changes, so a settled message is not
  // reparsed on every render — and never during a turn, because a forge provider does
  // not resolve or disappear mid-stream.
  const plugins = useMemo(
    () => [remarkGfm, remarkReferences({ forge: forgeAvailable }), remarkSoftBreaks],
    [forgeAvailable]
  );

  // Memoized on what the renderers actually read.
  //
  // An inline object here means a NEW component function for every element on every
  // render, so React unmounts and remounts each one — and a reference button that has
  // keyboard focus loses it on the next frame of a streaming turn. The message is
  // memoized on `content`, which changes on every token, so during a turn that is every
  // frame. (`AssistantLink` and `HighlightedCode` themselves are stable; it is the
  // arrow functions wrapping them that were not.)
  const components = useMemo<Components>(
    () => ({
      // A fenced block with a language gets syntax colour from the TERMINAL's own
      // ANSI slots (see `palette.ts`), so it reads as the same material as the pane
      // beside it rather than as a web page's idea of code.
      //
      // Held off until the turn settles. Mid-stream a fence is a syntactically
      // broken fragment, so highlighting it re-tokenises a growing buffer every
      // frame — quadratic over a turn — to show colours that are wrong until the
      // last character lands. The block visibly reinterprets itself as it fills.
      // Waiting costs one highlight and shows a stable answer.
      //
      // A fence with NO language stays plain: `refractor` cannot guess a grammar,
      // and picking one for the reader would colour a paste of log output as if it
      // were source.
      // `node` is react-markdown's own hast node, not a DOM attribute. Dropped
      // here rather than spread onto the element, which makes React warn about an
      // unknown prop on every inline code span. `MarkdownDocument` already does
      // this; the extraction copied the body without the guard.
      code: ({ node: _node, className: codeClassName, children, ...props }) => {
        const language = /language-([\w+-]+)/.exec(codeClassName ?? "")?.[1];
        if (language) {
          return (
            <HighlightedCode
              language={language}
              code={String(children).replace(/\n$/, "")}
              enabled={!streaming}
            />
          );
        }
        return (
          <code className={codeClassName} {...props}>
            {children}
          </code>
        );
      },
      // Markers are drawn from a CSS counter (see the stylesheet), so the ONE thing
      // the native list gave away for free has to be handed back: a list that does
      // not start at 1. `3. first item` is real markdown and arrives here as
      // `<ol start="3">`, which a counter knows nothing about — it would renumber the
      // list from 1 and quietly contradict the text.
      ol: ({ node: _node, start, style, ...props }) => (
        <ol
          {...props}
          style={
            typeof start === "number" && start !== 1
              ? { ...style, ["--assistant-ol-start" as string]: String(start - 1) }
              : style
          }
        />
      ),
      // Navigable text, in one primitive. A markdown link and a forge reference are
      // different elements for a mechanical reason (a reference has no URL of its
      // own) but ONE signal — both open the system browser — so `AssistantLink`
      // paints them identically. See that file.
      a: ({ node: _node, children, href, ...props }) => {
        const attrs: Record<string, unknown> = props;
        const kind = attrs["data-ref-kind"];
        const number = attrs["data-ref-number"];
        if (isReferenceKind(kind) && typeof number === "string") {
          const parsed = Number(number);
          // The reference carries no URL, so there is nothing for a missing handler
          // to navigate to — and a link that looks live and does nothing is worse
          // than plain text, so it renders as the plain text it came from.
          if (!onActivateReference || !Number.isSafeInteger(parsed) || parsed <= 0) {
            return <>{children}</>;
          }
          return (
            <AssistantLink onActivate={() => onActivateReference({ kind, number: parsed })}>
              {children}
            </AssistantLink>
          );
        }
        return <AssistantLink href={href}>{children}</AssistantLink>;
      },
    }),
    [streaming, onActivateReference]
  );

  return (
    <div className={cn("assistant-prose", streaming && "is-streaming", className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {source}
      </ReactMarkdown>
      {/* The caret is drawn as an ::after on the last block of prose (see the CSS), so
          it sits at the end of the final line rather than alone beneath it — as a
          sibling element it read as an empty paragraph and cost a line of vertical
          space on every streaming turn.
          
          This anchor exists ONLY for the pre-first-token case, where there is no block
          for the caret to attach to. Rendering it unconditionally would make it the
          last child and reintroduce exactly the layout it was meant to fix. */}
      {streaming && content.length === 0 && (
        <span aria-hidden="true" className="assistant-caret-anchor" />
      )}
    </div>
  );
});
