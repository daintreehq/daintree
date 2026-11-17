/** Why `value` can't be a link's address, or null when it can. */
export function linkUrlProblem(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "URL must use http:// or https://";
    return null;
  } catch {
    return "Enter a full URL, starting with https://";
  }
}

/** A problem pinned to the field that has to change, or to the form when neither does. */
export interface LinkError {
  field: "name" | "url" | "form";
  message: string;
}

export function validateLink(name: string, url: string): LinkError | null {
  if (!name.trim()) return { field: "name", message: "Enter a name for the link" };
  if (!url.trim()) return { field: "url", message: "Enter the link's URL" };
  const problem = linkUrlProblem(url);
  return problem ? { field: "url", message: problem } : null;
}
