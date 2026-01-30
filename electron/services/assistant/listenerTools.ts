/**
 * Listener Management Tools for Assistant Service
 *
 * Provides AI SDK tools for the assistant to manage event listeners.
 * These tools allow the assistant to subscribe to, list, and unsubscribe from
 * Canopy events during a conversation.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import { listenerManager } from "./ListenerManager.js";
import { ALL_EVENT_TYPES } from "../events.js";

/**
 * Event types that the assistant can subscribe to.
 * Derived from ALL_EVENT_TYPES in the events module.
 */
const ListenableEventTypeSchema = z.enum(ALL_EVENT_TYPES as [string, ...string[]]);

/**
 * Filter schema for narrowing event subscriptions.
 * Allows filtering by any field value (string, number, boolean, or null).
 * Accepts both undefined and null, normalizing to undefined internally.
 */
const ListenerFilterSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .nullable()
  .optional()
  .transform((val) => (val === null ? undefined : val))
  .describe("Optional filter to narrow events by field values (e.g., { terminalId: 'abc' })");

/**
 * Context provided to listener tools containing the session ID.
 */
export interface ListenerToolContext {
  sessionId: string;
}

/**
 * Create listener management tools for the assistant.
 *
 * @param context - Context containing the session ID for scoping listeners
 * @returns ToolSet containing register_listener, list_listeners, and remove_listener tools
 */
export function createListenerTools(context: ListenerToolContext): ToolSet {
  return {
    register_listener: tool({
      description:
        "Subscribe to Canopy events. Returns a listener ID for later removal. " +
        "Use this to monitor terminal activity, agent state changes, worktree updates, and more.",
      parameters: z.object({
        eventType: ListenableEventTypeSchema.describe(
          "The event type to subscribe to (e.g., 'agent:state-changed', 'terminal:activity')"
        ),
        filter: ListenerFilterSchema,
      }),
      execute: async ({ eventType, filter }) => {
        try {
          const listenerId = listenerManager.register(context.sessionId, eventType, filter);
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
      parameters: z.object({}),
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
      parameters: z.object({
        listenerId: z.string().min(1).describe("The listener ID to remove"),
      }),
      execute: async ({ listenerId }) => {
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
