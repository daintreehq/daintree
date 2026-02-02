import { z } from "zod";

const ListenerFilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ListenerFilterSchema = z.record(z.string(), ListenerFilterValueSchema).optional();
export type ListenerFilter = z.infer<typeof ListenerFilterSchema>;

export const ListenerSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  eventType: z.string().min(1),
  filter: ListenerFilterSchema,
  once: z.boolean().optional(),
  createdAt: z.number().finite().int(),
});
export type Listener = z.infer<typeof ListenerSchema>;

export const RegisterListenerOptionsSchema = z.object({
  sessionId: z.string().min(1),
  eventType: z.string().min(1),
  filter: ListenerFilterSchema,
  once: z.boolean().optional(),
});
export type RegisterListenerOptions = z.infer<typeof RegisterListenerOptionsSchema>;
