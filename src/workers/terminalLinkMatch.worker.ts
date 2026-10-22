/**
 * Plugin terminal link matching (#13798), off the renderer thread. A plugin's
 * pattern passes a static safety check at load, but that check is an estimate,
 * and a running `RegExp.exec` can't be interrupted — here, a pattern that runs
 * away costs this worker, which the client terminates, never the terminal.
 */

import {
  createTerminalLinkMatchHandler,
  type TerminalLinkMatchMessage,
  type TerminalLinkMatchRequest,
} from "../services/terminal/terminalLinkMatchWork";

const handle = createTerminalLinkMatchHandler((message: TerminalLinkMatchMessage) => {
  self.postMessage(message);
});

self.onmessage = (event: MessageEvent<TerminalLinkMatchRequest>) => {
  handle(event.data);
};
