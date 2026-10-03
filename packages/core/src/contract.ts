import { z } from "zod"

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1),
  fileId: z.string().trim().min(1).default("default"),
})

export const mapActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("showAll") }),
  z.object({
    kind: z.literal("show"),
    permitIds: z.array(z.string()),
  }),
])

export const chatResponseSchema = z.object({
  reply: z.string().min(1),
  map: mapActionSchema,
})

export const fileUploadSchema = z.object({
  csv: z.string().min(1),
  fileId: z.string().trim().min(1).optional(),
})

export const intentSchema = z.object({
  type: z.enum(["explain", "reset", "query"]),
  reply: z.string(),
  openOnly: z.boolean(),
  limit: z.number().nullable(),
  sort: z.enum(["review", "oldest", "newest", "homes"]),
  quadrant: z.enum(["SW", "NW", "NE", "SE"]).nullable(),
  ward: z.string().nullable(),
  community: z.string().nullable(),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>
export type ChatResponse = z.infer<typeof chatResponseSchema>
export type MapAction = z.infer<typeof mapActionSchema>
export type Intent = z.infer<typeof intentSchema>
