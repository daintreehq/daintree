import { removeStopwords, eng } from "stopword";

export interface TextSegment {
  type: "text" | "link";
  content: string;
  start: number;
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

export function parseNoteWithLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  const regex = new RegExp(URL_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
        start: lastIndex,
      });
    }
    segments.push({ type: "link", content: match[1]!, start: match.index });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex), start: lastIndex });
  }

  return segments;
}

export function formatPath(targetPath: string, homeDir?: string): string {
  const home = homeDir || "";
  if (home && targetPath.startsWith(home)) {
    return targetPath.replace(home, "~");
  }
  return targetPath;
}

/**
 * Shorten a file path by dropping middle directories, never its end.
 *
 * Distinct from {@link middleTruncate} beside it, which splits a generic string
 * evenly and so keeps the filename only by luck. A path's identifying part is
 * its tail — the filename, its extension and any `:line` suffix — so that is
 * what survives here and the directories are what give way.
 *
 * CSS `truncate` cuts the other end, which is why a long source path degrades
 * to `src/routes/marketing/campaigns/…` and loses the one piece the reader
 * came for. Pair this with a `title` carrying the full path.
 */
export function middleTruncatePath(path: string, maxLength: number = 44): string {
  // Code points, not UTF-16 units, for the same reason as `middleTruncate`.
  const chars = Array.from(path);
  if (chars.length <= maxLength) return path;

  const slash = path.lastIndexOf("/");
  const tail = slash === -1 ? path : path.slice(slash + 1);
  const tailChars = Array.from(tail);

  // A filename alone longer than the budget: keep its end, where the extension
  // and any line suffix live.
  if (tailChars.length + 2 >= maxLength) {
    return `…${chars.slice(chars.length - (maxLength - 1)).join("")}`;
  }

  const headBudget = Math.max(0, maxLength - tailChars.length - 2);
  return `${chars.slice(0, headBudget).join("")}…/${tail}`;
}

export function middleTruncate(text: string, maxLength: number = 40): string {
  // Code points, not UTF-16 units: slicing by index splits a surrogate pair in
  // half and renders a replacement glyph (git allows UTF-8 refs and paths).
  const chars = Array.from(text);
  if (chars.length <= maxLength) {
    return text;
  }

  const ellipsis = "…";
  const charsToShow = maxLength - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);

  return (
    chars.slice(0, frontChars).join("") + ellipsis + chars.slice(chars.length - backChars).join("")
  );
}

/**
 * Middle-truncates a git branch name while keeping what tells branches apart.
 *
 * Branches share their prefixes (`feature/`, `fix/`) and are told apart by the
 * ticket number after the prefix and the slug at the end. A character-halving cut
 * spends its budget on the prefix and splits the ticket (`feature/125...-dock-drop`);
 * this keeps `prefix/ticket-` whole when it leaves room for a real tail, and gives
 * the rest of the budget to the end of the slug.
 */
export function truncateBranchName(branch: string, maxLength: number = 24): string {
  const chars = Array.from(branch);
  if (chars.length <= maxLength) return branch;

  // The leading identifier is the whole run of number groups: a ticket (`12593-`)
  // or a date or version (`2026-09-`). Pinning only its first number would hide
  // the part that tells two such branches apart.
  const lead = /^(?:[^/]+\/)?\d+(?:[-_.]\d+)*[-_]/u.exec(branch)?.[0];
  const leadLength = lead ? Array.from(lead).length : 0;
  // The tail needs a few characters to carry the slug; below that the ticket
  // costs more than it earns and the plain halving cut is the better answer.
  const MIN_TAIL = 6;
  const headLength =
    lead && leadLength + 1 + MIN_TAIL <= maxLength ? leadLength : Math.ceil((maxLength - 1) / 2);
  const tailLength = maxLength - 1 - headLength;

  return `${chars.slice(0, headLength).join("")}…${chars.slice(chars.length - tailLength).join("")}`;
}

/** A commit's conventional short form: the first seven characters of its SHA. */
export function shortSha(sha: string | null | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

export function formatTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) {
    return "Never active";
  }

  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 1000) {
    return "Just now";
  }

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return `${seconds}s ago`;
  } else if (minutes < 60) {
    return `${minutes}m ago`;
  } else if (hours < 24) {
    return `${hours}h ago`;
  } else {
    return `${days}d ago`;
  }
}

/**
 * Generates a branch-safe slug from an issue title.
 * Filters stop words and limits to a character count to keep branch names concise.
 *
 * @param title - The issue title to convert
 * @param maxChars - Maximum characters for the title portion (default: 30)
 * @returns A lowercase, hyphen-separated slug suitable for branch names
 */
export function generateBranchSlug(title: string, maxChars: number = 30): string {
  // Extract words, filter non-alphanumeric, lowercase
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);

  // Remove English stopwords
  const filtered = removeStopwords(words, eng);

  if (filtered.length === 0) {
    return "";
  }

  // Build slug by adding words until we hit the character limit
  let slug = "";
  for (const word of filtered) {
    const nextSlug = slug ? `${slug}-${word}` : word;
    if (nextSlug.length > maxChars) {
      break;
    }
    slug = nextSlug;
  }

  // Ensure no trailing dash (shouldn't happen with this logic, but safety check)
  return slug.replace(/-+$/, "");
}

export function formatTimestampExact(timestamp: number | null | undefined): string {
  if (!timestamp) {
    return "No recent activity";
  }

  const date = new Date(timestamp);
  const now = new Date();

  const isToday = date.toDateString() === now.toDateString();
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isToday) {
    return `Last active: today at ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isYesterday) {
    return `Last active: yesterday at ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return `Last active: ${dateStr} at ${timeStr}`;
}
