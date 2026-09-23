// `credentialless` (Chrome 110+) loads an iframe in an ephemeral, credential-free
// context. It is what lets the COEP `credentialless` app shell embed a document
// that asserts no COEP of its own — the shape the inline PDF preview needs,
// since PDFium breaks if its document carries either a COEP or a `sandbox` CSP.
// @types/react has no typing for it.
//
// Typed as boolean because React 19.3 handles it as a known boolean attribute:
// `true` emits it and an empty string omits it. Before 19.3 the reverse held,
// so the React floor in package.json must stay at 19.3 or above.

import "react";

declare module "react" {
  // The type parameter is unused here but must match React's own declaration
  // exactly — TypeScript rejects an interface merge whose type parameters differ.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface IframeHTMLAttributes<T> {
    credentialless?: boolean;
  }
}
