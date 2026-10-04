import { chatRequestSchema, fileUploadSchema } from "@permit-pilot/core"
import { randomUUID } from "node:crypto"
import Fastify from "fastify"
import { answer } from "./agent"
import { getFile, loadDefaultFile, saveCsv } from "./files"

const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 })

app.get("/api/health", async () => ({ ok: true }))

app.post("/api/files", async (request, reply) => {
  const body = fileUploadSchema.safeParse(request.body)
  if (!body.success) return reply.code(400).send({ error: "Send the CSV text." })
  try {
    const fileId = body.data.fileId ?? randomUUID()
    const saved = saveCsv(fileId, body.data.csv)
    return { fileId, ...saved }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read that file."
    return reply.code(400).send({ error: message })
  }
})

app.post("/api/chat", async (request, reply) => {
  const body = chatRequestSchema.safeParse(request.body)
  if (!body.success) return reply.code(400).send({ error: "Send a message." })
  const permits = getFile(body.data.fileId)
  if (!permits) return reply.code(404).send({ error: "Load a file first." })
  return answer(body.data.message, body.data.fileId, permits)
})

const port = Number(process.env.PORT ?? 3001)
const loaded = loadDefaultFile()
app.log.info(`Default file ready: ${loaded.count} permits`)
await app.listen({ port, host: "127.0.0.1" })
