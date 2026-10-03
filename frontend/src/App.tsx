import { useCallback, useEffect, useRef, useState } from "react"
import { runAgent, SAMPLE_PROMPT } from "./agent"
import { MapView } from "./MapView"
import { parsePermitCsv } from "./parsePermits"
import type { Permit } from "./types"

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

const SAMPLE_URL = "/data/calgary_housing_development_permits.csv"

let messageId = 0

export function App() {
  const [permits, setPermits] = useState<Permit[]>([])
  const [skipped, setSkipped] = useState(0)
  const [fileName, setFileName] = useState("")
  const [visibleIds, setVisibleIds] = useState<string[] | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)

  const loadText = useCallback((name: string, text: string) => {
    const parsed = parsePermitCsv(text)
    if (parsed.permits.length === 0) {
      setError("No locations found. The file needs latitude and longitude columns.")
      setLoading(false)
      return
    }
    setPermits(parsed.permits)
    setSkipped(parsed.skipped)
    setFileName(name)
    setVisibleIds(null)
    setMessages([])
    setError("")
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(SAMPLE_URL)
      .then((response) => {
        if (!response.ok) throw new Error("Sample file missing")
        return response.text()
      })
      .then((text) => {
        if (!cancelled) loadText("calgary_housing_development_permits.csv", text)
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false)
          setError("Drop a CSV to plot it. Include latitude and longitude columns.")
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadText])

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
      if (file) readFile(file)
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

  function readFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") loadText(file.name, reader.result)
    }
    reader.readAsText(file)
  }

  function push(message: Omit<ChatMessage, "id">) {
    messageId += 1
    setMessages((current) => [...current, { ...message, id: messageId }].slice(-24))
  }

  function ask(text: string) {
    const prompt = text.trim()
    if (!prompt || permits.length === 0) return
    push({ role: "user", text: prompt })
    setDraft("")
    const result = runAgent(prompt, permits)
    if (result.mode === "reset") setVisibleIds(null)
    if (result.mode === "filter") setVisibleIds(result.ids)
    const shown = result.picks.length
    const hidden = result.mode === "filter" ? Math.max(0, result.ids.length - shown) : 0
    push({
      role: "agent",
      text: result.reply,
      picks: result.picks,
      more: hidden > 0 ? hidden : undefined,
    })
  }

  const onMapCount = visibleIds ? visibleIds.length : permits.length

  return (
    <div className="app">
      <MapView permits={permits} visibleIds={visibleIds} focus={focus} />

      <header className="panel top">
        <div>
          <div className="brand">Permit Pilot</div>
          <div className="sub">
            {loading && "Loading the sample file…"}
            {!loading && fileName && (
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
            )}
            {!loading && !fileName && "Drop a CSV with latitude and longitude"}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="top-actions">
          {visibleIds && (
            <button type="button" className="ghost" onClick={() => ask("show all")}>
              Show all
            </button>
          )}
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>
            Load CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) readFile(file)
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
              disabled={permits.length === 0}
              onClick={() => ask(SAMPLE_PROMPT)}
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
                      <button
                        type="button"
                        onClick={() => setFocus({ id: pick.id, n: Date.now() })}
                      >
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
              {message.more != null && message.more > 0 && (
                <div className="more">{message.more} more on the map</div>
              )}
            </article>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            ask(draft)
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={permits.length ? "Ask about this file" : "Load a CSV to start"}
            disabled={permits.length === 0}
            aria-label="Message the agent"
          />
          <button type="submit" className="send" disabled={!draft.trim() || permits.length === 0}>
            Send
          </button>
        </form>
      </section>

      {dragging && <div className="drop">Drop a CSV to map it</div>}
    </div>
  )
}
