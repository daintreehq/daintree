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
import { ALL_EVENT_TYPES } from "../events.js";

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
        "Use this to monitor terminal activity, agent state changes, worktree updates, and more.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          eventType: {
            type: "string",
            description: "The event type to subscribe to (e.g., 'agent:state-changed', 'terminal:activity')",
            enum: ALL_EVENT_TYPES,
          },
          filter: {
            type: "object",
            description: "Optional filter to narrow events by field values (e.g., { terminalId: 'abc' })",
            additionalProperties: {
              type: ["string", "number", "boolean", "null"],
            },
          },
        },
        required: ["eventType"],
      }),
      execute: async ({ eventType, filter }: { eventType: string; filter?: Record<string, any> }) => {
        try {
          const listenerId = listenerManager.register(context.sessionId, eventType as any, filter);
          return {
            success: true,
            listenerId,
            eventType,
            ...(filter ? { filter } : {}),
            message: `Successfully subscribed to ${eventType} events`,
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
        "Shows what events you are currently subscribed to.",
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
