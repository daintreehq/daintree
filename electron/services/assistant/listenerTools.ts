/**
 * Listener Management Tools for Assistant Service
 *
 * Provides AI SDK tools for the assistant to manage event listeners.
 * These tools allow the assistant to subscribe to, list, and unsubscribe from
 * Canopy events during a conversation.
 */

import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import { listenerManager } from "./ListenerManager.js";
import { BRIDGED_EVENT_TYPES, type BridgedEventType } from "../events.js";

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
        "Set once: true to automatically remove the listener after the first event (one-shot listener).",
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
              "Optional filter to narrow events by field values (e.g., { terminalId: 'abc', toState: 'completed' })",
            additionalProperties: true,
          },
          once: {
            type: "boolean",
            description:
              "If true, automatically remove the listener after the first matching event (one-shot listener). Default is false.",
          },
        },
        required: ["eventType"],
      }),
      execute: async ({
        eventType,
        filter,
        once,
      }: {
        eventType: BridgedEventType;
        filter?: Record<string, string | number | boolean | null>;
        once?: boolean;
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

          const listenerId = listenerManager.register(context.sessionId, eventType, filter, once);
          return {
            success: true,
            listenerId,
            eventType,
            ...(filter ? { filter } : {}),
            ...(once ? { once } : {}),
            message: once
              ? `Successfully subscribed to ${eventType} events (one-shot, will auto-remove after first event)`
              : `Successfully subscribed to ${eventType} events`,
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
  };
}
