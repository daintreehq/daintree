// Type surface for the plain-JS closure walk in first-render-closure-lib.mjs so
// vite.config.ts (type-checked under tsconfig.node.json, no allowJs) can import
// it. The .mjs stays dependency-free plain JS so the budget script can import it
// from plain Node ESM.
export function collectClosure<Node>(
  seedKeys: Iterable<string>,
  options: {
    getNode: (key: string) => Node | undefined | null;
    getStaticImports: (node: Node) => readonly string[] | undefined | null;
    getDynamicImports: (node: Node) => readonly string[] | undefined | null;
    followDynamic?: boolean;
  }
): Set<string>;
