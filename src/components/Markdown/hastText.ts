import type { ElementContent } from "hast";

/** The text of a hast subtree, optionally leaving out the elements `skip` names. */
export function hastText(
  nodes: readonly ElementContent[],
  skip?: (element: Extract<ElementContent, { type: "element" }>) => boolean
): string {
  let text = "";
  for (const child of nodes) {
    if (child.type === "text") text += child.value;
    else if (child.type === "element" && !skip?.(child)) text += hastText(child.children, skip);
  }
  return text;
}
