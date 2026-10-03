import { chatResponseSchema, type Permit } from "@permit-pilot/core"
import { useCallback, useEffect, useRef, useState } from "react"
import defaultCsv from "../data/calgary_housing_development_permits.csv?raw"
import { MapView } from "./MapView"
import { parsePermitCsv } from "./parsePermits"

type ChatMessage = {
  id: number
  role: "user" | "agent"
  text: string
  picks?: {
    id: string
    homes: number
    stated: boolean
    address: string
    community: string
  }[]
  more?: number
}

const SAMPLE_PROMPT = "Give me the 50 files to review first this week."

let messageId = 0

async function registerFile(fileId: string, csv: string): Promise<string> {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv, fileId }),
  })
  const body = (await response.json().catch(() => ({}))) as { fileId?: string; error?: string }
  if (!response.ok || !body.fileId) {
    throw new Error(body.error ?? "The review service did not accept this file.")
  }
  return body.fileId
}

export function App() {
  const [permits, setPermits] = useState<Permit[]>([])
  const [skipped, setSkipped] = useState(0)
  const [fileName, setFileName] = useState("")
  const [fileId, setFileId] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const [visibleIds, setVisibleIds] = useState<string[] | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const loadGen = useRef(0)

  const loadText = useCallback((name: string, text: string) => {
    const parsed = parsePermitCsv(text)
    if (parsed.permits.length === 0) {
      setError("No locations found. The file needs latitude and longitude columns.")
      return false
    }
    setPermits(parsed.permits)
    setSkipped(parsed.skipped)
    setFileName(name)
    setVisibleIds(null)
    setMessages([])
    setError("")
    return true
  }, [])

  const connectFile = useCallback(async (id: string, csv: string, gen: number) => {
    setLinking(true)
    try {
      const saved = await registerFile(id, csv)
      if (gen !== loadGen.current) return
      setFileId(saved)
    } catch (caught) {
      if (gen !== loadGen.current) return
      setFileId(null)
      setError(caught instanceof Error ? caught.message : "Start the backend to chat about this file.")
    } finally {
      if (gen === loadGen.current) setLinking(false)
    }
  }, [])

  const openFile = useCallback(
    (name: string, text: string, id: string) => {
      if (!loadText(name, text)) return
      const gen = ++loadGen.current
      void connectFile(id, text, gen)
    },
    [connectFile, loadText],
  )

  useEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    const users = thread.querySelectorAll(".msg.user")
    const latest = users[users.length - 1]
    if (latest instanceof HTMLElement) {
      thread.scrollTop = Math.max(0, latest.offsetTop - thread.offsetTop - 4)
    }
  }, [messages])

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
    }
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const file = event.dataTransfer?.files?.[0]
      if (file) readDropped(file)
    }
    window.addEventListener("dragenter", onDragEnter)
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("dragleave", onDragLeave)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragenter", onDragEnter)
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("dragleave", onDragLeave)
      window.removeEventListener("drop", onDrop)
    }
  }, [])

  function readDropped(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== "string") return
      openFile(file.name, reader.result, `upload-${Date.now()}`)
    }
    reader.readAsText(file)
  }

  function push(message: Omit<ChatMessage, "id">) {
    messageId += 1
    setMessages((current) => [...current, { ...message, id: messageId }].slice(-24))
  }

  async function ask(text: string) {
    const prompt = text.trim()
    if (!prompt || permits.length === 0) return
    push({ role: "user", text: prompt })
    setDraft("")
    if (!fileId) {
      push({
        role: "agent",
        text: "The map has the file. Start the backend so chat can rank it.",
      })
      return
    }
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: prompt, fileId }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        push({ role: "agent", text: body.error ?? "The review service could not answer." })
        return
      }
      const result = chatResponseSchema.parse(body)
      if (result.map.kind === "show") setVisibleIds(result.map.permitIds)
      if (result.map.kind === "showAll") setVisibleIds(null)
      const picks =
        result.map.kind === "show"
          ? result.map.permitIds.slice(0, 6).flatMap((id) => {
              const permit = permits.find((item) => item.id === id)
              if (!permit) return []
              return [
                {
                  id,
                  homes: permit.homes,
                  stated: permit.stated,
                  address: permit.address,
                  community: permit.community,
                },
              ]
            })
          : undefined
      const hidden = result.map.kind === "show" ? result.map.permitIds.length - (picks?.length ?? 0) : 0
      push({
        role: "agent",
        text: result.reply,
        picks,
        more: hidden > 0 ? hidden : undefined,
      })
    } catch {
      push({
        role: "agent",
        text: "The review service is not running. From the repo root, run npm run dev.",
      })
    }
  }

  const onMapCount = visibleIds ? visibleIds.length : permits.length

  return (
    <div className="app">
      <MapView permits={permits} visibleIds={visibleIds} focus={focus} />

      <header className="panel top">
        <div>
          <div className="brand">Permit Pilot</div>
          <div className="sub">
            {fileName ? (
              <>
                {onMapCount.toLocaleString("en-CA")} on the map
                <span className="sep">·</span>
                {fileName}
                {skipped > 0 && (
                  <>
                    <span className="sep">·</span>
                    {skipped} without coordinates
                  </>
                )}
              </>
            ) : (
              "Load the default file, or upload a CSV"
            )}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="top-actions">
          {visibleIds && (
            <button type="button" className="ghost" onClick={() => void ask("show all")}>
              Show all
            </button>
          )}
          <button
            type="button"
            className="ghost"
            onClick={() => openFile("calgary_housing_development_permits.csv", defaultCsv, "default")}
          >
            Load default data
          </button>
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>
            Upload CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) readDropped(file)
              event.target.value = ""
            }}
          />
        </div>
      </header>

      <section className="panel chat">
        <div className="thread" ref={threadRef}>
          {messages.length === 0 && (
            <button
              type="button"
              className="suggest"
              disabled={permits.length === 0 || !fileId}
              onClick={() => void ask(SAMPLE_PROMPT)}
            >
              {SAMPLE_PROMPT}
            </button>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`msg ${message.role}`}>
              {message.role === "agent" && <div className="who">Agent</div>}
              <p>{message.text}</p>
              {message.picks && message.picks.length > 0 && (
                <ol className="picks">
                  {message.picks.map((pick) => (
                    <li key={pick.id}>
                      <button type="button" onClick={() => setFocus({ id: pick.id, n: Date.now() })}>
                        <span className="pick-id">{pick.id}</span>
                        <span className="pick-meta">
                          {pick.stated ? `${pick.homes} homes` : `~${pick.homes} homes`}
                          {pick.address ? ` · ${pick.address}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              {message.more != null && message.more > 0 && <div className="more">{message.more} more on the map</div>}
            </article>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void ask(draft)
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              permits.length === 0
                ? "Load a CSV to start"
                : linking
                  ? "Connecting the review service"
                  : "Ask about this file"
            }
            disabled={permits.length === 0 || !fileId}
            aria-label="Message the agent"
          />
          <button type="submit" className="send" disabled={!draft.trim() || !fileId}>
            Send
          </button>
        </form>
      </section>

      {dragging && <div className="drop">Drop a CSV to map it</div>}
    </div>
  )
}
