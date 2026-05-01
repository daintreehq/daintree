/**
 * Permissions-Policy header value for the trusted Daintree renderer.
 *
 * Mirrors the deny-by-default posture of the permission handlers in
 * electron/setup/security.ts. Only microphone is allowed (voice dictation
 * into terminal inputs). Every other powerful feature is explicitly denied.
 *
 * Applied as an HTTP response header via `buildHeaders()` in the app://
 * protocol handler (electron/utils/appProtocol.ts). There is no <meta>
 * equivalent for Permissions-Policy in Chromium 146.
 */
export const DAINTREE_APP_PERMISSIONS_POLICY = [
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "microphone=(self)",
  "midi=()",
  "screen-wake-lock=()",
  "usb=()",
].join(", ");
