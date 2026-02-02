/**
 * Listener Management Tools for Assistant Service
 *
 * Provides AI SDK tools for the assistant to manage event listeners.
 * These tools allow the assistant to subscribe to, list, and unsubscribe from
 * Canopy events during a conversation.
 */

import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import { listenerManager, listenerWaiter } from "./ListenerManager.js";
import { pendingEventQueue } from "./PendingEventQueue.js";
import { BRIDGED_EVENT_TYPES, type BridgedEventType } from "../events.js";
import type { AutoResumeOptions, AutoResumeContext } from "../../../shared/types/listener.js";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 60000; // 60 seconds - longer waits should use autoResume

// Mutable copy for JSON schema compatibility
const BRIDGED_EVENT_TYPES_MUTABLE: string[] = [...BRIDGED_EVENT_TYPES];

/**
 * Context provided to listener tools containing the session ID.
 */
export interface ListenerToolContext {
  sessionId: string;
}

/**
 * Create listener management tools for the assistant.
 */
export function createListenerTools(context: ListenerToolContext): ToolSet {
  return {
    register_listener: tool({
      description:
        "Subscribe to Canopy events. Returns a listener ID for later removal. " +
        `Currently supported events: ${BRIDGED_EVENT_TYPES.join(", ")}. ` +
        "terminal:state-changed fires when a terminal's agent state changes (e.g., idle → working → completed). " +
        "agent:completed fires when an agent finishes successfully (includes exitCode and duration). " +
        "agent:failed fires when an agent encounters an error (includes error message). " +
        "agent:killed fires when an agent is terminated. " +
        "Filter by terminalId, agentId, and/or worktreeId. " +
        "Set once: true to automatically remove the listener after the first event (one-shot listener). " +
        "Use autoResume to automatically continue the conversation when the event triggers - " +
        "provide a prompt that will be injected as a synthetic user message to resume the assistant. " +
        "IMPORTANT: autoResume is one-shot - it will trigger only once per registration, even for persistent listeners. " +
        "After the first trigger, subsequent events will show as regular listener notifications.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          eventType: {
            type: "string",
            description:
              "The event type to subscribe to: terminal:state-changed, agent:completed, agent:failed, or agent:killed.",
            enum: BRIDGED_EVENT_TYPES_MUTABLE,
          },
          filter: {
            type: "object",
            description:
              "CRITICAL: If you need the terminalId from a just-launched agent, do NOT call register_listener in the same tool batch " +
              "(including multi_tool_use) as agent_launch. Wait for agent_launch to return, then pass the returned terminalId. " +
              "Optional filter to narrow events by field values (e.g., { terminalId: 'abc', toState: 'completed' }). " +
              "Consider using agent_launchWithAutoResume for the common pattern.",
            additionalProperties: true,
          },
          once: {
            type: "boolean",
            description:
              "If true, automatically remove the listener after the first matching event (one-shot listener). Default is false.",
          },
          autoResume: {
            type: "object",
            description:
              "Optional auto-resume configuration. When the listener triggers, automatically continue the conversation " +
              "by injecting the specified prompt as a synthetic user message. This enables non-blocking autonomous workflows " +
              "where you can register a listener and respond later without user intervention.",
            properties: {
              prompt: {
                type: "string",
                description:
                  "The message to inject when resuming (e.g., 'The agent has completed. Continue with the next step.')",
              },
              context: {
                type: "object",
                description: "Optional context to preserve for the resumed conversation",
                properties: {
                  plan: {
                    type: "string",
                    description: "A plan or checklist of steps to continue from",
                  },
                  lastToolCalls: {
                    type: "array",
                    description: "Tool calls that were pending before the wait",
                  },
                  metadata: {
                    type: "object",
                    description: "Any additional metadata to preserve",
                    additionalProperties: true,
                  },
                },
              },
            },
            required: ["prompt"],
          },
        },
        required: ["eventType"],
      }),
      execute: async ({
        eventType,
        filter,
        once,
        autoResume,
      }: {
        eventType: BridgedEventType;
        filter?: Record<string, string | number | boolean | null>;
        once?: boolean;
        autoResume?: { prompt: string; context?: AutoResumeContext };
      }) => {
        try {
          // Runtime validation: ensure eventType is actually bridged
          // This guards against schema bypass or non-tool registration paths
          if (!BRIDGED_EVENT_TYPES.includes(eventType as BridgedEventType)) {
            return {
              success: false,
              error: `Event type '${eventType}' is not supported. Supported events: ${BRIDGED_EVENT_TYPES.join(", ")}`,
            };
          }

          // Validate autoResume if provided
          let autoResumeOptions: AutoResumeOptions | undefined;
          if (autoResume) {
            if (!autoResume.prompt || typeof autoResume.prompt !== "string") {
              return {
                success: false,
                error: "autoResume.prompt is required and must be a non-empty string",
              };
            }
            autoResumeOptions = {
              prompt: autoResume.prompt,
              context: autoResume.context,
            };
          }

          const listenerId = listenerManager.register(
            context.sessionId,
            eventType,
            filter,
            once,
            autoResumeOptions
          );

          const messages: string[] = [];
          if (once) {
            messages.push("one-shot, will auto-remove after first event");
          }
          if (autoResumeOptions) {
            messages.push("auto-resume enabled");
          }

          const suffix = messages.length > 0 ? ` (${messages.join(", ")})` : "";

          // Use directive message when autoResume is enabled to signal assistant should end turn
          const message = autoResumeOptions
            ? "Listener registered with auto-resume. END YOUR TURN NOW - the conversation will automatically continue when the event fires. Do not poll, check status, or make additional tool calls. Simply inform the user you're waiting."
            : `Successfully subscribed to ${eventType} events${suffix}`;

          return {
            success: true,
            listenerId,
            eventType,
            ...(filter ? { filter } : {}),
            ...(once ? { once } : {}),
            ...(autoResumeOptions ? { autoResume: true } : {}),
            message,
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to register listener",
          };
        }
      },
    }),

    list_listeners: tool({
      description:
        "List all active event listeners for this conversation. " +
        "Shows what events you are currently subscribed to, including one-shot listeners.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
      }),
      execute: async () => {
        const listeners = listenerManager.listForSession(context.sessionId);
        return {
          success: true,
          count: listeners.length,
          listeners: listeners.map((l) => ({
            listenerId: l.id,
            eventType: l.eventType,
            ...(l.filter ? { filter: l.filter } : {}),
            ...(l.once ? { once: l.once } : {}),
            createdAt: l.createdAt,
          })),
        };
      },
    }),

    remove_listener: tool({
      description:
        "Unsubscribe from events by listener ID. " +
        "Use the listener ID returned from register_listener or list_listeners.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          listenerId: {
            type: "string",
            description: "The listener ID to remove",
          },
        },
        required: ["listenerId"],
      }),
      execute: async ({ listenerId }: { listenerId: string }) => {
        // Verify the listener belongs to this session before removing
        const listener = listenerManager.get(listenerId);

        if (!listener) {
          return {
            success: false,
            removed: false,
            error: "Listener not found",
          };
        }

        if (listener.sessionId !== context.sessionId) {
          return {
            success: false,
            removed: false,
            error: "Listener not found",
          };
        }

        const removed = listenerManager.unregister(listenerId);
        return {
          success: true,
          removed,
          listenerId,
          message: removed ? "Listener removed successfully" : "Listener was already removed",
        };
      },
    }),

    list_pending_events: tool({
      description:
        "List all pending (unacknowledged) listener events for this conversation. " +
        "Events are queued when listeners trigger, even if you weren't actively streaming. " +
        "Use this to see what events fired while you were working on other tasks. " +
        "Events are sorted by timestamp (oldest first).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          includeAcknowledged: {
            type: "boolean",
            description:
              "If true, include events that have already been acknowledged. Default is false.",
          },
        },
      }),
      execute: async ({ includeAcknowledged }: { includeAcknowledged?: boolean }) => {
        const events = includeAcknowledged
          ? pendingEventQueue.getAll(context.sessionId)
          : pendingEventQueue.getPending(context.sessionId);

        return {
          success: true,
          count: events.length,
          events: events.map((e) => ({
            eventId: e.id,
            listenerId: e.listenerId,
            eventType: e.eventType,
            data: e.data,
            timestamp: e.timestamp,
            acknowledged: e.acknowledged,
          })),
        };
      },
    }),

    acknowledge_event: tool({
      description:
        "Mark a pending event as acknowledged (seen). " +
        "Acknowledged events won't appear in the pending events list or context injection. " +
        "Use 'all' as eventId to acknowledge all pending events at once.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "The event ID to acknowledge, or 'all' to acknowledge all pending events",
          },
        },
        required: ["eventId"],
      }),
      execute: async ({ eventId }: { eventId: string }) => {
        if (eventId === "all") {
          const count = pendingEventQueue.acknowledgeAll(context.sessionId);
          return {
            success: true,
            acknowledged: count,
            message:
              count > 0 ? `Acknowledged ${count} event(s)` : "No pending events to acknowledge",
          };
        }

        const acknowledged = pendingEventQueue.acknowledge(eventId, context.sessionId);
        return {
          success: acknowledged,
          eventId,
          message: acknowledged
            ? "Event acknowledged"
            : "Event not found or not owned by this session",
        };
      },
    }),

    await_listener: tool({
      description:
        "Block and wait for a registered listener to trigger. Returns the event data when triggered or an error on timeout. " +
        "Use this ONLY for short, bounded waits (up to 60 seconds). " +
        "For longer or unknown duration waits, use register_listener with autoResume instead. " +
        "The listener must be registered first using register_listener. " +
        "Cannot be used with listeners that have autoResume enabled.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          listenerId: {
            type: "string",
            description: "The listener ID returned from register_listener",
          },
          timeoutMs: {
            type: "number",
            description:
              "Maximum time to wait in milliseconds (default: 30000, max: 60000). " +
              "For waits longer than 60s, use autoResume instead.",
            minimum: 1,
            maximum: 60000,
          },
        },
        required: ["listenerId"],
      }),
      execute: async (
        { listenerId, timeoutMs }: { listenerId: string; timeoutMs?: number },
        { abortSignal }
      ) => {
        // Check if event already fired and is in pending queue FIRST
        // This must come before listener validation to handle one-shot listeners
        // that have already been removed but have queued events
        const pendingEvents = pendingEventQueue.getPending(context.sessionId);
        const matchingEvent = pendingEvents.find((e) => e.listenerId === listenerId);

        if (matchingEvent) {
          // Event already fired - return immediately
          console.log(
            `[await_listener] Event already in pending queue for listener ${listenerId}, returning immediately`
          );

          // Acknowledge the event
          pendingEventQueue.acknowledge(matchingEvent.id, context.sessionId);

          return {
            success: true,
            eventType: matchingEvent.eventType,
            data: matchingEvent.data,
            waitedMs: 0,
            source: "pending_queue",
            message: "Event was already pending - returned immediately without blocking",
          };
        }

        // No pending event - validate listener exists and belongs to this session
        const listener = listenerManager.get(listenerId);
        if (!listener) {
          return {
            success: false,
            error: "not_found",
            message: "Listener not found or already triggered",
          };
        }

        if (listener.sessionId !== context.sessionId) {
          return {
            success: false,
            error: "not_found",
            message: "Listener not found or already triggered",
          };
        }

        // Prevent await_listener on autoResume listeners to avoid race conditions
        if (listener.autoResume) {
          return {
            success: false,
            error: "invalid_listener",
            message:
              "Cannot await a listener with autoResume enabled. Use autoResume for non-blocking waits.",
          };
        }

        // Check if already awaiting this listener
        if (listenerWaiter.isAwaiting(listenerId)) {
          return {
            success: false,
            error: "already_awaiting",
            message: "Already awaiting this listener",
          };
        }

        // No pending event - proceed with blocking wait

        // Validate timeout - reject if too long (force use of autoResume for long waits)
        const rawTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Reject explicitly if timeout exceeds maximum (with helpful error)
        if (Number.isFinite(rawTimeout) && rawTimeout > MAX_TIMEOUT_MS) {
          return {
            success: false,
            error: "timeout_too_long",
            message: `Timeout ${rawTimeout}ms exceeds maximum ${MAX_TIMEOUT_MS}ms. For longer waits, use register_listener with autoResume instead of await_listener.`,
            maxAllowed: MAX_TIMEOUT_MS,
          };
        }

        // Normalize to valid range (defensive fallback for invalid inputs)
        const effectiveTimeout = Number.isFinite(rawTimeout)
          ? Math.max(rawTimeout, 1)
          : DEFAULT_TIMEOUT_MS;

        const startTime = Date.now();

        // Check if already aborted
        if (abortSignal?.aborted) {
          return {
            success: false,
            error: "cancelled",
            reason: "Stream was already cancelled",
            waitedMs: 0,
          };
        }

        // Set up abort signal handler
        const abortHandler = () => {
          listenerWaiter.cancel(listenerId, "cancelled");
        };
        abortSignal?.addEventListener("abort", abortHandler);

        try {
          const event = await listenerWaiter.wait(listenerId, effectiveTimeout, context.sessionId);
          return {
            success: true,
            eventType: event.eventType,
            data: event.data,
            waitedMs: Date.now() - startTime,
          };
        } catch (error) {
          const waitedMs = Date.now() - startTime;
          const errorMessage = error instanceof Error ? error.message : "unknown";

          if (errorMessage === "timeout") {
            return {
              success: false,
              error: "timeout",
              waitedMs,
            };
          }

          if (errorMessage === "cancelled") {
            return {
              success: false,
              error: "cancelled",
              reason: "Stream was cancelled",
              waitedMs,
            };
          }

          return {
            success: false,
            error: "unknown",
            message: errorMessage,
            waitedMs,
          };
        } finally {
          abortSignal?.removeEventListener("abort", abortHandler);
        }
      },
    }),
  };
}
