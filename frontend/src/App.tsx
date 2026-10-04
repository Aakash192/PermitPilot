import { useCallback, useEffect, useRef, useState } from "react"
import { runAgent, SAMPLE_PROMPT } from "./agent"
import { askAgent, fetchPermits, fetchScoreboard, type ChatTurn, type Scoreboard } from "./api"
import { MapView } from "./MapView"
import { parsePermitCsv } from "./parsePermits"
import type { AgentResult, Permit } from "./types"
import "./live.css"

// One-click questions for the demo (live agent only).
const DEMO_PROMPTS = [
  "How does PermitPilot compare to oldest-first this week?",
  "Show the top 20 files to review this week",
  "Why is DP2025-02163 ranked where it is?",
  "We lost two planners this week, what drops?",
]

// Plain-language labels for the agent's tools.
const TOOL_LABELS: Record<string, string> = {
  search_permits: "Searched the permits",
  rank_queue: "Ranked this week's queue",
  simulate_capacity_cut: "Re-planned for fewer planners",
  get_permit: "Looked up the permit",
  compare_rankings: "Compared with oldest-first",
  clear_map: "Reset the map",
}

type ChatMessage = {
  id: number
  role: "user" | "agent"
  text: string
  tools?: string[]
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

// The AI marks key numbers as **bold**; show them bold instead of with asterisks.
function withBold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part))
}

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
  // live = permits came from the backend, so chat goes to the AI agent there.
  const [live, setLive] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [score, setScore] = useState<Scoreboard | null>(null)
  const historyRef = useRef<ChatTurn[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)

  const loadPermits = useCallback((name: string, rows: Permit[], skippedRows: number, fromBackend: boolean) => {
    setPermits(rows)
    setSkipped(skippedRows)
    setFileName(name)
    setLive(fromBackend)
    setVisibleIds(null)
    setMessages([])
    historyRef.current = []
    setError("")
    setLoading(false)
  }, [])

  const loadText = useCallback((name: string, text: string) => {
    const parsed = parsePermitCsv(text)
    if (parsed.permits.length === 0) {
      setError("No locations found. The file needs latitude and longitude columns.")
      setLoading(false)
      return
    }
    loadPermits(name, parsed.permits, parsed.skipped, false)
  }, [loadPermits])

  useEffect(() => {
    let cancelled = false
    // Backend first; if it is not running, fall back to the bundled CSV and the local agent.
    fetchPermits()
      .then((rows) => {
        if (cancelled) return
        loadPermits("calgary_housing_development_permits.csv", rows, 0, true)
        fetchScoreboard()
          .then((board) => {
            if (!cancelled) setScore(board)
          })
          .catch(() => undefined)
      })
      .catch(() =>
        fetch(SAMPLE_URL)
          .then((response) => {
            if (!response.ok) throw new Error("Sample file missing")
            return response.text()
          })
          .then((text) => {
            if (!cancelled) loadText("calgary_housing_development_permits.csv", text)
          }),
      )
      .catch(() => {
        if (!cancelled) {
          setLoading(false)
          setError("Drop a CSV to plot it. Include latitude and longitude columns.")
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadPermits, loadText])

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

  async function ask(text: string) {
    const prompt = text.trim()
    if (!prompt || permits.length === 0 || thinking) return
    push({ role: "user", text: prompt })
    setDraft("")

    let result: AgentResult
    let tools: string[] | undefined
    if (live) {
      setThinking(true)
      try {
        const reply = await askAgent(prompt, historyRef.current)
        result = reply
        tools = [
          ...new Set(
            reply.actions.filter((action) => action.ok).map((action) => TOOL_LABELS[action.tool] ?? action.tool),
          ),
        ]
        historyRef.current = [
          ...historyRef.current,
          { role: "user" as const, content: prompt },
          { role: "assistant" as const, content: reply.reply },
        ].slice(-10)
      } catch {
        // Backend or OpenAI unavailable: answer with the local rule-based agent instead.
        result = runAgent(prompt, permits)
        tools = ["AI unavailable, answered offline"]
      } finally {
        setThinking(false)
      }
    } else {
      result = runAgent(prompt, permits)
    }

    if (result.mode === "reset") setVisibleIds(null)
    if (result.mode === "filter") setVisibleIds(result.ids)
    const shown = result.picks.length
    const hidden = result.mode === "filter" ? Math.max(0, result.ids.length - shown) : 0
    push({
      role: "agent",
      text: result.reply,
      tools: tools && tools.length > 0 ? tools : undefined,
      picks: result.picks,
      more: hidden > 0 ? hidden : undefined,
    })
  }

  // Shows whether a home count was read by the AI or is an estimate a planner should confirm.
  function homesTag(id: string) {
    const permit = permits.find((p) => p.id === id)
    if (!permit || permit.needsReview == null) return null
    return (
      <>
        {permit.needsReview ? (
          <span className="tag check">estimate, planner to confirm</span>
        ) : permit.homesSource === "llm" ? (
          <span className="tag">AI-counted</span>
        ) : null}
        {permit.nearCorridor && (
          <span className="tag check" title="Within 300 m of the Transportation Utility Corridor (ring road and major utility lines)">
            {permit.corridorMeters === 0 ? "in utility corridor" : `${permit.corridorMeters} m from utility corridor`}
          </span>
        )}
      </>
    )
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
                <span className="sep">·</span>
                {live ? "Live AI agent" : "Offline mode"}
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
          {live && score && (
            <div className="score" title="Same weekly workload, two ways of choosing the files">
              <span>This week's {score.capacity} reviews:</span>
              <span className="pair">
                oldest-first <strong>{score.fifo.homesInList}</strong> homes
                <span className="arrow"> → </span>
                <span className="win">
                  PermitPilot <strong>{score.pilot.homesInList}</strong> homes
                </span>
              </span>
              <span>{score.queueSize} files waiting on a planner</span>
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="top-actions">
          {visibleIds && (
            <button type="button" className="ghost" onClick={() => setVisibleIds(null)}>
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
          {messages.length === 0 &&
            (live ? DEMO_PROMPTS : [SAMPLE_PROMPT]).map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="suggest"
                disabled={permits.length === 0 || thinking}
                onClick={() => ask(prompt)}
              >
                {prompt}
              </button>
            ))}
          {messages.map((message) => (
            <article key={message.id} className={`msg ${message.role}`}>
              {message.role === "agent" && <div className="who">Agent</div>}
              <p>{withBold(message.text)}</p>
              {message.tools && <div className="tools">{message.tools.join(" · ")}</div>}
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
                          {live && homesTag(pick.id)}
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
          {thinking && (
            <article className="msg agent">
              <div className="who">Agent</div>
              <p>Thinking…</p>
            </article>
          )}
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
          <button type="submit" className="send" disabled={!draft.trim() || permits.length === 0 || thinking}>
            Send
          </button>
        </form>
      </section>

      {dragging && <div className="drop">Drop a CSV to map it</div>}
    </div>
  )
}
