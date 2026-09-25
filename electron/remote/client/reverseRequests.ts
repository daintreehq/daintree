import { AppError } from "../../utils/errorTypes.js";
import type { ReverseRequestAnswerer, ViewReverseRequest } from "./RemoteHostManager.js";

/** Answers one reverse-request method for a view; the resolved value goes back to the host. */
export type ReverseRequestMethodHandler = (request: ViewReverseRequest) => unknown;

const handlers = new Map<string, ReverseRequestMethodHandler>();

/**
 * Let hosts ask this Shell's views `method`. One handler per method; the
 * returned function removes it (only if it is still the registered one).
 */
export function registerReverseRequestMethod(
  method: string,
  handler: ReverseRequestMethodHandler
): () => void {
  handlers.set(method, handler);
  return () => {
    if (handlers.get(method) === handler) handlers.delete(method);
  };
}

/**
 * The one answerer every host session uses. A method nobody registered is
 * refused as UNSUPPORTED rather than guessed at.
 */
export const answerReverseRequest: ReverseRequestAnswerer = async (request) => {
  const handler = handlers.get(request.method);
  if (!handler) {
    throw new AppError({ code: "UNSUPPORTED", message: `No handler for ${request.method}` });
  }
  return handler(request);
};

/** @internal Tests only. */
export function _resetReverseRequestMethodsForTesting(): void {
  handlers.clear();
}
