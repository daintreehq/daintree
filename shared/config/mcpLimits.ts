/**
 * Byte ceiling for the text body of an MCP `tools/call` response or resource
 * read (#11526), measured on compact UTF-8 JSON.
 *
 * Shared rather than private to the main-process transport so the renderer
 * actions that produce terminal tails can fit them under it before
 * serialization (#12450). The transport cap is a backstop that keeps the head of
 * the text — the wrong end for a tail read — so a producer whose data has a
 * natural "newest" end must budget against this number itself.
 */
export const MCP_RESPONSE_TEXT_MAX_BYTES = 50 * 1024;
