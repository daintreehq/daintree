/**
 * The first sentence of a manifest description. Descriptions are written for
 * the agents that read the MCP tool surface too, so many run on into
 * implementation notes ("This is a …", "It accepts a subset of …") that
 * truncate mid-clause in a one-line palette row. The row shows what the entry
 * does; search still reads the whole description.
 */
export function paletteSummary(description: string): string {
  const match = /^(.+?(?<!\b\w)[.!?])(\s+[A-Z]|$)/.exec(description.trim());
  const sentence = match ? match[1]! : description.trim();
  return sentence.replace(/\.$/, "");
}
