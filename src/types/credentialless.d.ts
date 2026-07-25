// `credentialless` (Chrome 110+) loads an iframe in an ephemeral, credential-free
// context. It is what lets the COEP `credentialless` app shell embed a document
// that asserts no COEP of its own — the shape the inline PDF preview needs,
// since PDFium breaks if its document carries either a COEP or a `sandbox` CSP.
// React 19 has no typing for it.
//
// Typed as the empty string, not boolean, on purpose: React treats an unknown
// attribute with a `true` value as a non-boolean it should omit, so
// `credentialless={true}` silently renders nothing. `credentialless=""` is
// emitted, and an empty string is a present attribute per the HTML spec.

import "react";

declare module "react" {
  // The type parameter is unused here but must match React's own declaration
  // exactly — TypeScript rejects an interface merge whose type parameters differ.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface IframeHTMLAttributes<T> {
    credentialless?: "";
  }
}
