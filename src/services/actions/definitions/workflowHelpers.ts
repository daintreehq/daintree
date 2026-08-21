import { formatPartialSuccessMessage } from "@shared/utils/partialSuccess";

export function partialSuccessError(message: string, partial: Record<string, unknown>): Error {
  return new Error(formatPartialSuccessMessage(message, partial));
}

export function slugifyForBranch(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "work"
  );
}
