export type RateLimitRow = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnap = {
  tokens?: number
  window: number
  percent?: number
  rateLimits: RateLimitRow[]
  costUsd?: number
}

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
}

export type ToolStat = {
  calls: number
  errors: number
  denied: number
  totalMs: number
  maxMs: number
}

export type AgentState = 'running' | 'completed' | 'failed' | 'killed'

export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  status: AgentState
  startedAt: number
  durationMs?: number
}

export type PanelId =
  | 'context'
  | 'limits'
  | 'cost'
  | 'tools'
  | 'agents'
  | 'forecast'
  | 'time'
  | 'files'
  | 'bash'
  | 'week'

export type SortKey = 'time' | 'calls' | 'errors' | 'avg' | 'max' | 'name'

/** How the context alert speaks: a toast, a status line entry, both, or not at all. */
export type AlertMode = 'off' | 'toast' | 'status' | 'both'

export type Prefs = {
  /** Which default set the layout was made against; an older one starts from the new defaults. */
  layout: number
  hidden: PanelId[]
  collapsed: PanelId[]
  sort: SortKey
  reverse: boolean
  alert: AlertMode
  /** Context fill, in percent, at which the alert fires. */
  threshold: number
}

/** How often a file was read and changed this session. */
export type FileStat = { reads: number; edits: number; lastAt: number }

/** One Bash command family (`git status`, `docker compose`): its calls, failures and time. */
export type CommandStat = { calls: number; errors: number; totalMs: number }

/** Where the session's time went: inside turns, and inside the tools those turns ran. */
export type Timing = { turnMs: number; toolMs: number; turns: number }

/** A rate-limit reading at a moment, for the burn rate. */
export type LimitSample = { at: number; percent: number }

/** One day's totals across every session on this machine. */
export type DayStat = { usd: number; tokensIn: number; tokensOut: number; turns: number }

declare module 'claude-code' {
  interface PluginState {
    cctop: {
      usage: UsageSnap | null
      history: number[]
      costs: number[]
      tokens: Tokens
      tools: Record<string, ToolStat>
      agents: AgentRow[]
      prefs: Prefs
      model: string
      startedAt: number
      cwd: string
      files: Record<string, FileStat>
      commands: Record<string, CommandStat>
      timing: Timing
      samples: Record<string, LimitSample[]>
      days: Record<string, DayStat>
      isAlerted: boolean
    }
  }
}
