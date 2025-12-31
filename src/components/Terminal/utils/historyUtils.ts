import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { escapeHtml, escapeHtmlAttribute, linkifyHtml } from "./htmlUtils";

export const HISTORY_JUMP_BACK_PERSIST_MS = 100;
export const HISTORY_JUMP_BACK_PERSIST_FRAMES = 2;

export interface HistoryState {
  lines: string[];
  htmlLines: string[];
  windowStart: number;
  windowEnd: number;
  takenAt: number;
}

/**
 * Parse xterm's serializeAsHTML output to extract individual row HTML.
 * The output format is:
 * <html><body><!--StartFragment--><pre>
 * <div style='...'>
 *   <div><span>row content</span><span>more content</span>...</div>
 *   ...
 * </div>
 * </pre><!--EndFragment--></body></html>
 *
 * Uses DOMParser for robust HTML parsing - the previous regex approach
 * only captured the first <span> per row, truncating multi-styled rows.
 */
const HTML_ENTITY_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

const HTML_ENTITY_REGEX = /[&<>"']/g;

function escapeHtmlText(value: string): string {
  return value.replace(
    HTML_ENTITY_REGEX,
    (char) => HTML_ENTITY_MAP[char as keyof typeof HTML_ENTITY_MAP]
  );
}

/**
 * Pre-escapes text content inside xterm's HTML output before DOMParser processes it.
 *
 * xterm's serializeAsHTML() outputs raw cell content without escaping, so if terminal
 * output contains `<tag>`, xterm produces `<span><tag></span>`. When DOMParser parses
 * this, it interprets `<tag>` as a real HTML element, corrupting the DOM structure
 * and causing rows to disappear.
 *
 * This function escapes ALL angle brackets in text content while preserving only
 * the specific xterm HTML structure patterns we expect.
 *
 * SECURITY: We must be extremely strict about what tags are allowed. Any tag in
 * terminal output (even <div> or <span>) should be escaped to prevent DOM corruption
 * and CSS injection attacks.
 */
function preEscapeXtermHtml(html: string): string {
  // Fast path: if no angle brackets, return unchanged
  if (!html.includes("<") && !html.includes(">")) {
    return html;
  }

  // xterm produces a very specific structure:
  // <html><body><!--StartFragment--><pre><div style="..."><div><span ...>text</span>...</div></div></pre><!--EndFragment--></body></html>
  //
  // Strategy: We need to be CONTEXT-AWARE, not just tag-name aware.
  // Tags are only valid in specific positions:
  // 1. Root structure: <html>, <body>, <pre> at the start
  // 2. Row container: <div style="..."> after <pre>
  // 3. Row elements: <div> as children of row container
  // 4. Content: <span ...> inside row divs
  // 5. HTML comments: <!--StartFragment-->, <!--EndFragment-->
  //
  // ANYTHING ELSE should be escaped, including:
  // - <div>, </div>, <span>, </span> appearing in text content
  // - Any other tags anywhere
  //
  // We use a state machine approach to track context

  const result: string[] = [];
  let i = 0;
  let depth = 0; // Track nesting depth: 0=html, 1=body, 2=pre, 3=container, 4=row, 5=span

  while (i < html.length) {
    if (html[i] === "<") {
      const remaining = html.slice(i);

      // Check for HTML comments (allowed anywhere)
      if (remaining.startsWith("<!--")) {
        const endIdx = remaining.indexOf("-->", 4);
        if (endIdx !== -1) {
          result.push(remaining.slice(0, endIdx + 3));
          i += endIdx + 3;
          continue;
        }
      }

      // Check for expected structural tags based on depth
      // This is strict: tags are only allowed in specific contexts
      const tagMatch = remaining.match(/^<(\/?)(\w+)(\s[^>]*)?>/) ;
      if (tagMatch) {
        const [fullMatch, isClosing, tagName] = tagMatch;
        const isAllowed =
          (depth === 0 && tagName === "html" && !isClosing) ||
          (depth === 1 && tagName === "html" && isClosing) ||
          (depth === 1 && tagName === "body" && !isClosing) ||
          (depth === 2 && tagName === "body" && isClosing) ||
          (depth === 2 && tagName === "pre" && !isClosing) ||
          (depth === 3 && tagName === "pre" && isClosing) ||
          (depth === 3 && tagName === "div" && !isClosing) || // Row container
          (depth === 4 && tagName === "div" && !isClosing) || // Row
          (depth === 4 && tagName === "div" && isClosing) || // Row container close
          (depth === 5 && tagName === "div" && isClosing) || // Row close
          (depth === 5 && tagName === "span" && !isClosing) ||
          (depth === 6 && tagName === "span" && isClosing);

        if (isAllowed) {
          result.push(fullMatch);
          i += fullMatch.length;
          // Update depth
          if (!isClosing) {
            depth++;
          } else {
            depth--;
          }
          continue;
        }
      }

      // Not an allowed tag - escape it
      result.push("&lt;");
      i++;
    } else if (html[i] === ">") {
      // Standalone > - escape it
      result.push("&gt;");
      i++;
    } else {
      result.push(html[i]);
      i++;
    }
  }

  return result.join("");
}

function serializeXtermNode(node: ChildNode): string {
  if (node.nodeType === 3) {
    return escapeHtmlText(node.textContent ?? "");
  }

  if (node.nodeType !== 1) return "";

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();

  // STRICT whitelist: only span tags are allowed from xterm's serializeAsHTML
  // xterm produces: <pre><div><div><span style="...">content</span></div></div></pre>
  // The outer divs are row containers (processed by querySelectorAll), content is in spans.
  // We don't allow div/a here because:
  // - div: should never appear as content inside a row; if present, it's likely unescaped HTML
  // - a: links are created by linkifyHtml later, not by xterm
  // Any other tags (script, img, etc.) are escaped to prevent XSS
  if (tagName !== "span") {
    return escapeHtmlText(element.textContent ?? "");
  }

  // STRICT attribute whitelist: only style attribute is allowed
  // xterm's serializeAsHTML only produces style attributes for coloring
  // Use escapeHtmlAttribute for attribute values to prevent attribute injection
  const styleAttr = element.getAttribute("style");
  const attrs = styleAttr ? ` style="${escapeHtmlAttribute(styleAttr)}"` : "";

  const children = Array.from(element.childNodes, serializeXtermNode).join("");
  return `<span${attrs}>${children}</span>`;
}

export function parseXtermHtmlRows(html: string): string[] {
  // Pre-escape text content to prevent DOMParser from interpreting raw < and > as HTML tags
  // This is critical: xterm's serializeAsHTML outputs raw cell content without escaping
  const safeHtml = preEscapeXtermHtml(html);
  const doc = new DOMParser().parseFromString(safeHtml, "text/html");
  // Rows are nested: pre > div (container) > div (each row)
  const rowDivs = doc.querySelectorAll("pre > div > div");
  return Array.from(rowDivs, (div) => {
    const rowHtml = Array.from(div.childNodes, serializeXtermNode).join("");
    return linkifyHtml(rowHtml) || " ";
  });
}

export function extractSnapshot(
  term: Terminal,
  serializeAddon: SerializeAddon | null,
  maxLines: number,
  skipBottomLines: number = 0
): HistoryState {
  const buffer = term.buffer.active;
  const total = buffer.length;
  const cols = term.cols;

  const effectiveEnd = Math.max(0, total - skipBottomLines);
  const count = Math.min(maxLines, effectiveEnd);
  const start = Math.max(0, effectiveEnd - count);

  // Extract plain text lines for diff comparison
  const lines: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const line = buffer.getLine(start + i);
    lines[i] = line ? line.translateToString(true, 0, cols) : "";
  }

  let htmlLines: string[];
  if (serializeAddon) {
    try {
      // Use serializeAsHTML for pixel-perfect xterm rendering
      // This uses xterm's internal theme colors and cell-by-cell rendering
      const fullHtml = serializeAddon.serializeAsHTML({
        scrollback: count,
        onlySelection: false,
        includeGlobalBackground: false,
      });

      htmlLines = parseXtermHtmlRows(fullHtml);

      // Handle skipBottomLines by removing rows from the end
      if (skipBottomLines > 0 && htmlLines.length > skipBottomLines) {
        htmlLines = htmlLines.slice(0, -skipBottomLines);
      }

      // Ensure we have the right number of rows, pad with empty if needed
      while (htmlLines.length < count) {
        htmlLines.push(" ");
      }

      // Trim to maxLines if we got more
      if (htmlLines.length > count) {
        htmlLines = htmlLines.slice(htmlLines.length - count);
      }
    } catch {
      htmlLines = lines.map((l) => escapeHtml(l) || " ");
    }
  } else {
    htmlLines = lines.map((l) => escapeHtml(l) || " ");
  }

  return {
    lines,
    htmlLines,
    windowStart: start,
    windowEnd: effectiveEnd,
    takenAt: performance.now(),
  };
}

export function computeTrimmedTopCount(
  oldState: HistoryState | null,
  newState: HistoryState
): number {
  if (!oldState) return 0;

  const primaryTrimmed = Math.max(0, newState.windowStart - oldState.windowStart);
  if (primaryTrimmed > 0) return primaryTrimmed;

  const oldLines = oldState.lines;
  const newLines = newState.lines;

  if (oldLines.length === 0 || newLines.length === 0) return 0;

  const probeLen = Math.min(20, oldLines.length, newLines.length);
  const maxShift = Math.min(500, oldLines.length - probeLen);

  const probeStart = Math.max(0, oldLines.length - probeLen - 50);
  const probe = oldLines.slice(probeStart, probeStart + probeLen);

  for (let shift = 0; shift <= maxShift; shift++) {
    const searchIdx = probeStart - shift;
    if (searchIdx < 0) break;

    let match = true;
    for (let i = 0; i < probeLen && searchIdx + i < newLines.length; i++) {
      if (newLines[searchIdx + i] !== probe[i]) {
        match = false;
        break;
      }
    }
    if (match) return shift;
  }

  return 0;
}

export function shouldAcceptSnapshot(
  now: number,
  lastOutputAt: number,
  oldLines: string[],
  newLines: string[],
  settleMs: number
): boolean {
  if (now - lastOutputAt >= settleMs) return true;

  const checkCount = Math.min(40, oldLines.length, newLines.length);
  let changedLines = 0;

  for (let i = 1; i <= checkCount; i++) {
    const oldIdx = oldLines.length - i;
    const newIdx = newLines.length - i;
    if (oldIdx < 0 || newIdx < 0) break;

    if (oldLines[oldIdx] !== newLines[newIdx]) {
      changedLines++;
      if (changedLines > 5) return false;
    }
  }

  return true;
}

export function checkJumpBackPersistence(
  newWindowStart: number,
  lastAcceptedWindowStart: number | null,
  pendingJumpBack: { windowStart: number; firstSeenAt: number; stableFrames: number } | null,
  now: number
): {
  accept: boolean;
  newPendingState: { windowStart: number; firstSeenAt: number; stableFrames: number } | null;
} {
  if (lastAcceptedWindowStart === null) {
    return { accept: true, newPendingState: null };
  }

  if (newWindowStart >= lastAcceptedWindowStart) {
    return { accept: true, newPendingState: null };
  }

  const sameCandidate = pendingJumpBack && pendingJumpBack.windowStart === newWindowStart;

  let newPending: { windowStart: number; firstSeenAt: number; stableFrames: number };
  if (sameCandidate) {
    newPending = {
      ...pendingJumpBack,
      stableFrames: pendingJumpBack.stableFrames + 1,
    };
  } else {
    newPending = {
      windowStart: newWindowStart,
      firstSeenAt: now,
      stableFrames: 1,
    };
  }

  const elapsed = now - newPending.firstSeenAt;
  const shouldAccept =
    elapsed >= HISTORY_JUMP_BACK_PERSIST_MS ||
    newPending.stableFrames >= HISTORY_JUMP_BACK_PERSIST_FRAMES;

  if (shouldAccept) {
    return { accept: true, newPendingState: null };
  }

  return { accept: false, newPendingState: newPending };
}
