/**
 * Brace-balanced extraction of at-rule bodies from CSS source.
 *
 * CSS rules that only exist inside an at-rule (`@variant reduce-motion`,
 * `@media (forced-colors: active)`) are invisible to jsdom, so they are guarded
 * by asserting on source. A lazy `/@variant reduce-motion[\s\S]*?\.foo/` regex
 * does NOT prove containment — it happily scans out of one block and into a
 * later one, so the assertion silently stops meaning anything as soon as a
 * second block of the same kind is added above it. Walk the braces instead.
 */
export function extractAtRuleBlocks(css: string, marker: string): string[] {
  const blocks: string[] = [];

  let searchFrom = 0;
  for (;;) {
    const start = css.indexOf(marker, searchFrom);
    if (start === -1) break;

    const open = css.indexOf("{", start);
    if (open === -1) break;

    let depth = 0;
    let end = open;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    blocks.push(css.slice(open, end + 1));
    searchFrom = end + 1;
  }

  return blocks;
}

/**
 * The declared `transition-property` values for `.selector` within `css`, as a
 * set — or null when no such rule declares exactly one. Callers pass Tailwind
 * class tokens, which carry regex metacharacters (`hover:bg-[var(--x)]`), so the
 * selector is escaped rather than interpolated raw.
 */
export function transitionPropertiesFor(css: string, selector: string): Set<string> | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`\\.${escaped}\\s*\\{([^{}]*)\\}`).exec(css);
  if (!rule) return null;

  const declarations = [...rule[1].matchAll(/\btransition-property\s*:\s*([^;}]+)/g)];
  if (declarations.length !== 1) return null;

  return new Set(declarations[0][1].split(",").map((property) => property.trim()));
}
