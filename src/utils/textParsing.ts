import { removeStopwords, eng } from "stopword";

export interface TextSegment {
  type: "text" | "link";
  content: string;
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

export function parseNoteWithLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  const regex = new RegExp(URL_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "link", content: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
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

export function middleTruncate(text: string, maxLength: number = 40): string {
  if (text.length <= maxLength) {
    return text;
  }

  const ellipsis = "...";
  const charsToShow = maxLength - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);

  return text.slice(0, frontChars) + ellipsis + text.slice(text.length - backChars);
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
