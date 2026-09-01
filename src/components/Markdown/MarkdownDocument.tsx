import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { refractor } from "refractor/core";
import {
  ensureLanguage,
  isLanguageFailed,
  isLanguageRegistered,
} from "@/components/Worktree/diffRefractor";
import { dirname, isAbsolute, isPathInside, join, normalize } from "@shared/utils/path";
import { buildDaintreeFileUrl } from "@/components/FileViewer/filePreviewKinds";
import { useScopedSelectAll } from "@/hooks/useScopedSelectAll";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { cn } from "@/lib/utils";
import type { MarkdownFontSize } from "@/store/preferencesStore";
import "./MarkdownDocument.css";

/**
 * Each reading rung resolved to the shared type scale. Spelled out rather than
 * interpolated so the map is greppable, but typed against the rung name so a
 * mismatched pair is a compile error rather than an unresolved `var()` that
 * silently falls back. Same shape as `DIFF_FONT_SIZE` — the preference names a
 * step of the app's scale, so it keeps tracking the scale when the scale moves.
 */
const MARKDOWN_FONT_SIZE_TOKEN: { [K in MarkdownFontSize]: `var(--text-${K})` } = {
  "2xs": "var(--text-2xs)",
  xs: "var(--text-xs)",
  sm: "var(--text-sm)",
  base: "var(--text-base)",
  lg: "var(--text-lg)",
  xl: "var(--text-xl)",
  "2xl": "var(--text-2xl)",
  "3xl": "var(--text-3xl)",
};

/** `MarkdownDocument.css` reads this; declaring it here is what applies the rung. */
type MarkdownFontStyle = CSSProperties & Record<"--markdown-font-size", string>;

export interface MarkdownDocumentProps {
  /** Markdown source text */
  content: string;
  /** Absolute path of the file, used to resolve relative links and images */
  filePath: string;
  /** Containment root for daintree-file:// image loads */
  rootPath: string;
  /**
   * Cache-busting token appended to local image URLs. The daintree-file:// URL
   * is otherwise a pure function of path + root, so a rewritten image keeps a
   * byte-identical `src` and Chromium never refetches it (#11587). Hosts pass
   * whatever token already tracks their refresh cycle; same `cacheBust` idiom
   * as FileImagePreview and ZoomableImage.
   */
  cacheBust?: string;
  className?: string;
  /**
   * Reading scale for this document, as a rung of the shared type scale. Absent
   * leaves the CSS fallback in charge, which is the size every surface rendered
   * at before the control existed (#12134).
   */
  fontSize?: MarkdownFontSize;
  /**
   * Fired once the document has committed. Hosts that pinned their height
   * across the swap into rendered mode use this to release the pin (#11255).
   */
  onRendered?: () => void;
}

/**
 * Fence-info aliases → the grammar keys diffRefractor's loaders know.
 * refractor registers Prism's own aliases (ts, py, …) once the grammar is
 * loaded; this map only bridges the *loader* lookup for grammars that are
 * still cold.
 */
const FENCE_LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  dockerfile: "docker",
  html: "markup",
  xml: "markup",
};

function canonicalLang(lang: string): string {
  const lower = lang.toLowerCase();
  return FENCE_LANG_ALIASES[lower] ?? lower;
}

/**
 * Syntax-highlighted fence body. Highlights synchronously when the grammar is
 * registered; otherwise kicks off diffRefractor's lazy grammar load and
 * re-renders once it lands. Falls back to plain text for unknown grammars —
 * same downgrade behavior as the diff viewer.
 */
function HighlightedCode({ language, code }: { language: string; code: string }) {
  const lang = canonicalLang(language);
  const [grammarRevision, setGrammarRevision] = useState(0);

  useEffect(() => {
    if (isLanguageRegistered(lang) || isLanguageFailed(lang)) return;
    let cancelled = false;
    void ensureLanguage(lang).then(() => {
      if (!cancelled) setGrammarRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const highlighted = useMemo<ReactNode>(() => {
    void grammarRevision;
    if (!isLanguageRegistered(lang)) return null;
    try {
      return toJsxRuntime(refractor.highlight(code, lang), { Fragment, jsx, jsxs });
    } catch {
      return null;
    }
  }, [code, lang, grammarRevision]);

  return <code className={`language-${lang}`}>{highlighted ?? code}</code>;
}

/** Resolve a link/image target against the document's directory. */
function resolveAgainstFile(filePath: string, target: string): string {
  return isAbsolute(target) ? normalize(target) : normalize(join(dirname(filePath), target));
}

const HTTPish = /^(https?|mailto):/i;

/**
 * Read-only rendered view of a markdown document. Shared by the markdown
 * panel and the file viewer dialog. GFM (tables, task lists, strikethrough,
 * autolinks) is on; raw HTML embedded in the markdown is intentionally never
 * rendered — there is no rehype-raw in the pipeline and `skipHtml` drops the
 * raw nodes entirely. That is the safety boundary that lets this render
 * arbitrary repo files inside an Electron renderer without a sanitizer.
 */
export function MarkdownDocument({
  content,
  filePath,
  rootPath,
  cacheBust,
  className,
  fontSize,
  onRendered,
}: MarkdownDocumentProps) {
  // Runs after the first commit, which is the point the host's height pin can
  // hand the box back to the document. Cold fence grammars land later and swap
  // plain text for span-wrapped identical text — same characters, same line
  // count, so they can't shrink the box and don't gate this.
  useEffect(() => {
    onRendered?.();
  }, [onRendered]);

  // Nothing owns Select All over plain rendered DOM, so the native Edit-menu
  // command falls back to the whole app (#12135). Claim it for the document.
  const rootRef = useRef<HTMLDivElement>(null);
  useScopedSelectAll(rootRef);

  const urlTransform = useMemo(() => {
    return (url: string, key: string): string | null | undefined => {
      if (key === "src") {
        // Images: remote stays remote (default sanitization), anything
        // path-like resolves through the daintree-file:// protocol so local
        // images referenced by specs render with the same containment checks
        // as the file itself.
        if (HTTPish.test(url) || url.startsWith("data:")) return defaultUrlTransform(url);
        const local = buildDaintreeFileUrl(resolveAgainstFile(filePath, url), rootPath);
        // Undefined-checked rather than truthy, matching FileImagePreview and
        // ZoomableImage: the token is opaque, so only "no host is tracking
        // freshness" suppresses it — "" is a value like any other, and folding
        // it in with absent would make a host that legitimately reached "" stop
        // busting. The protocol handler reads only path/root, so `v` is inert.
        return cacheBust === undefined ? local : `${local}&v=${encodeURIComponent(cacheBust)}`;
      }
      return defaultUrlTransform(url);
    };
  }, [filePath, rootPath, cacheBust]);

  const handleLinkActivate = useMemo(() => {
    return (href: string | undefined) => {
      // Same-document anchors: headings carry no ids (no rehype-slug), so
      // there is nothing to scroll to — swallow instead of navigating.
      if (!href || href.startsWith("#")) return;
      if (HTTPish.test(href)) {
        actionService
          .dispatch("browser.openExternal", { url: href }, { source: "user" })
          .catch((err) => logError("[MarkdownDocument] openExternal failed", err));
        return;
      }
      // Protocol-relative ("//host/…") and other non-http schemes survive to
      // here only as untrusted oddities — never treat them as local paths.
      if (href.startsWith("//")) return;
      // Repo link — strip any query/fragment, resolve against the document,
      // and only open files the document's own root contains. Rendered
      // markdown is untrusted content; it must not become a lever for
      // browsing arbitrary paths outside the project.
      const pathPart = href.split(/[?#]/, 1)[0];
      if (!pathPart) return;
      const absolute = resolveAgainstFile(filePath, pathPart);
      if (!isPathInside(absolute, rootPath)) return;
      actionService
        .dispatch("file.view", { path: absolute, rootPath }, { source: "user" })
        .catch((err) => logError("[MarkdownDocument] file.view failed", err));
    };
  }, [filePath, rootPath]);

  const components = useMemo<Components>(
    () => ({
      code: ({ node: _node, className: codeClassName, children, ...props }) => {
        const language = /language-([\w+-]+)/.exec(codeClassName ?? "")?.[1];
        if (language) {
          return <HighlightedCode language={language} code={String(children).replace(/\n$/, "")} />;
        }
        return (
          <code className={codeClassName} {...props}>
            {children}
          </code>
        );
      },
      a: ({ node: _node, href, children, ...props }) => (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            handleLinkActivate(href);
          }}
          onAuxClick={(event) => {
            // Middle-click would otherwise ask Chromium to open the href in a
            // new window — no link in rendered markdown should navigate.
            event.preventDefault();
          }}
        >
          {children}
        </a>
      ),
    }),
    [handleLinkActivate]
  );

  const fontStyle: MarkdownFontStyle | undefined =
    fontSize === undefined
      ? undefined
      : { "--markdown-font-size": MARKDOWN_FONT_SIZE_TOKEN[fontSize] };

  return (
    <div ref={rootRef} className={cn("markdown-document prose", className)} style={fontStyle}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={components}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
