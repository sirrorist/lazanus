import type {
  AgentRow,
  AlertMode,
  CommandStat,
  DayStat,
  FileStat,
  LimitSample,
  PanelId,
  Prefs,
  SortKey,
  Timing,
  Tokens,
  ToolStat,
  UsageSnap,
} from '../types'

/**
 * Every panel in its order: the five shown by default first (keys 1-5), the
 * optional ones after (6-9 and 0). `about` is the menu's one-line explanation.
 */
export const PANELS: readonly { id: PanelId; title: string; about: string; isDefault: boolean }[] = [
  { id: 'context', title: 'context', about: 'window fill by turn', isDefault: true },
  { id: 'limits', title: 'limits', about: '5h and 7d windows', isDefault: true },
  { id: 'tools', title: 'tools', about: 'calls, errors, timing', isDefault: true },
  { id: 'agents', title: 'agents', about: 'running subagents', isDefault: true },
  { id: 'week', title: 'week', about: 'cost per day', isDefault: true },
  { id: 'cost', title: 'cost', about: '$, tokens, cache', isDefault: false },
  { id: 'forecast', title: 'forecast', about: 'when limits run out', isDefault: false },
  { id: 'time', title: 'time', about: 'model, tools, you', isDefault: false },
  { id: 'files', title: 'files', about: 'most touched files', isDefault: false },
  { id: 'bash', title: 'bash', about: 'shell commands', isDefault: false },
]

/** The panel's number and key: its place in PANELS, 10 written as 0. */
export const panelNumber = (id: PanelId): number => PANELS.findIndex(panel => panel.id === id) + 1

/** Bumped when the default set changes, so stored layouts made against the old one start over. */
export const LAYOUT_VERSION = 2

/** In two columns (from 100 cells) these panels go left, the rest right. */
export const LEFT_PANELS: readonly PanelId[] = ['context', 'limits', 'week', 'cost', 'forecast', 'time']

export const ALERT_MODES: readonly AlertMode[] = ['toast', 'status', 'both', 'off']

export const THRESHOLDS: readonly number[] = [60, 70, 80, 90]

export const SORTS: readonly SortKey[] = ['time', 'calls', 'errors', 'avg', 'max', 'name']

export const DEFAULT_PREFS: Prefs = {
  layout: LAYOUT_VERSION,
  hidden: PANELS.filter(panel => !panel.isDefault).map(panel => panel.id),
  collapsed: [],
  sort: 'time',
  reverse: false,
  alert: 'toast',
  threshold: 70,
}

/** Everything a drawing needs, as plain data: what a `Client` takes as props. */
export type Snapshot = {
  now: number
  startedAt: number
  model: string
  columns: number
  rows: number
  usage: UsageSnap | null
  history: number[]
  costs: number[]
  tokens: Tokens
  tools: Record<string, ToolStat>
  agents: AgentRow[]
  prefs: Prefs
  cwd: string
  files: Record<string, FileStat>
  commands: Record<string, CommandStat>
  timing: Timing
  samples: Record<string, LimitSample[]>
  days: Record<string, DayStat>
}

/** What the drawing asks the hooks to change, posted from a `Client` or pressed on a Button. */
export type Action =
  | { kind: 'collapse'; panel: PanelId }
  | { kind: 'visible'; panel: PanelId; on: boolean }
  | { kind: 'sort'; key: SortKey }
  | { kind: 'alert' }
  | { kind: 'threshold' }
  | { kind: 'reset' }

const isPanel = (value: unknown): value is PanelId => PANELS.some(panel => panel.id === value)

const isSort = (value: unknown): value is SortKey => SORTS.some(key => key === value)

/** A posted message comes from code, so it is checked before it is trusted. */
export const parseAction = (data: unknown): Action | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const { kind, panel, on, key } = data as Record<string, unknown>
  if (kind === 'collapse' && isPanel(panel)) return { kind, panel }
  if (kind === 'visible' && isPanel(panel) && typeof on === 'boolean') return { kind, panel, on }
  if (kind === 'sort' && isSort(key)) return { kind, key }
  if (kind === 'reset' || kind === 'alert' || kind === 'threshold') return { kind }

  return undefined
}

const toggle = (list: readonly PanelId[], panel: PanelId, on: boolean): PanelId[] =>
  on ? [...new Set([...list, panel])] : list.filter(one => one !== panel)

export const applyAction = (prefs: Prefs, action: Action): Prefs => {
  switch (action.kind) {
    case 'collapse':
      return { ...prefs, collapsed: toggle(prefs.collapsed, action.panel, !prefs.collapsed.includes(action.panel)) }
    case 'visible':
      return { ...prefs, hidden: toggle(prefs.hidden, action.panel, !action.on) }
    case 'sort':
      return action.key === prefs.sort
        ? { ...prefs, reverse: !prefs.reverse }
        : { ...prefs, sort: action.key, reverse: false }
    case 'alert':
      return { ...prefs, alert: ALERT_MODES[(ALERT_MODES.indexOf(prefs.alert) + 1) % ALERT_MODES.length] ?? 'toast' }
    case 'threshold':
      return { ...prefs, threshold: THRESHOLDS[(THRESHOLDS.indexOf(prefs.threshold) + 1) % THRESHOLDS.length] ?? 70 }
    case 'reset':
      // The layout goes back to the defaults; the alert settings are not layout and stay.
      return { ...DEFAULT_PREFS, alert: prefs.alert, threshold: prefs.threshold }
  }
}

/** A stored value from an older build or a hand edit falls back field by field. */
export const parsePrefs = (stored: unknown): Prefs => {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_PREFS
  const { layout, hidden, collapsed, sort, reverse, alert, threshold } = stored as Record<string, unknown>
  const panels = (value: unknown) => (Array.isArray(value) ? value.filter(isPanel) : [])
  const isCurrent = layout === LAYOUT_VERSION

  return {
    layout: LAYOUT_VERSION,
    hidden: isCurrent ? panels(hidden) : DEFAULT_PREFS.hidden,
    collapsed: isCurrent ? panels(collapsed) : [],
    sort: isSort(sort) ? sort : DEFAULT_PREFS.sort,
    reverse: reverse === true,
    alert: ALERT_MODES.find(mode => mode === alert) ?? DEFAULT_PREFS.alert,
    threshold: THRESHOLDS.find(value => value === threshold) ?? DEFAULT_PREFS.threshold,
  }
}

export type ToolRow = { name: string } & ToolStat

export const sortedTools = (tools: Record<string, ToolStat>, sort: SortKey, reverse: boolean): ToolRow[] => {
  const value = (row: ToolRow): number | string => {
    switch (sort) {
      case 'time':
        return row.totalMs
      case 'calls':
        return row.calls
      case 'errors':
        return row.errors + row.denied
      case 'avg':
        return row.totalMs / Math.max(1, row.calls)
      case 'max':
        return row.maxMs
      case 'name':
        return row.name.toLowerCase()
    }
  }
  const rows = Object.entries(tools).map(([name, stat]) => ({ name, ...stat }))
  // Numbers read biggest first, names from A; `reverse` flips either.
  const direction = (sort === 'name' ? 1 : -1) * (reverse ? -1 : 1)

  return rows.sort((a, b) => {
    const left = value(a)
    const right = value(b)

    return (left < right ? -1 : left > right ? 1 : 0) * direction
  })
}

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
}

/**
 * How far ahead of an even spend a window is, in percentage points: used share
 * minus the elapsed share. Undefined where the window's length is unknown.
 */
export const pace = (kind: string, percentUsed: number, resetsAt: string | undefined, now: number): number | undefined => {
  const length = WINDOW_MS[kind]
  if (length === undefined || resetsAt === undefined) return undefined
  const left = Date.parse(resetsAt) - now
  if (Number.isNaN(left)) return undefined
  const elapsed = Math.min(1, Math.max(0, 1 - left / length))

  return percentUsed - elapsed * 100
}

/** Where an even spend would stand now, 0 to 1, for the marker on a limit's gauge. */
export const elapsedShare = (kind: string, resetsAt: string | undefined, now: number): number | undefined => {
  const value = pace(kind, 0, resetsAt, now)

  return value === undefined ? undefined : -value / 100
}

export const perHour = (usd: number | undefined, startedAt: number, now: number): number | undefined => {
  const hours = (now - startedAt) / 3_600_000
  if (usd === undefined || startedAt <= 0 || hours < 1 / 60) return undefined

  return usd / hours
}

/**
 * Cost of each turn from the running totals sampled after each one. The first
 * sample has no turn before it to subtract: its total is everything spent
 * before the mod was watching, so it starts the series and is not a turn.
 */
export const deltas = (totals: readonly number[]): number[] =>
  totals.slice(1).map((total, i) => Math.max(0, total - (totals[i] ?? 0)))

export const shortModel = (model: string): string =>
  model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')

export const visiblePanels = (prefs: Prefs): PanelId[] =>
  PANELS.map(panel => panel.id).filter(id => !prefs.hidden.includes(id))

// Analytics: pure functions over what the hooks collected.

/** Programs whose first argument names what they did (`git status`, `docker compose`). */
const WITH_SUBCOMMAND = new Set([
  'git', 'docker', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'composer', 'claude',
  'systemctl', 'kubectl', 'pacman', 'yay', 'brew', 'apt', 'pip', 'uv', 'php', 'artisan',
])

/**
 * The family a shell command belongs to: its first program, with the
 * subcommand for tools that have them. `cd dir && make` counts as `make`,
 * `sudo` and `VAR=1` prefixes are skipped.
 */
export const commandKey = (command: string): string => {
  const parts = command.split(/&&|\|\||;|\|/).map(part => part.trim()).filter(Boolean)
  const main = parts.find(part => !/^cd\s/.test(part) && part !== 'cd') ?? parts[0] ?? ''
  const words = main.split(/\s+/).filter(word => !/^\w+=/.test(word))
  while (words[0] === 'sudo' || words[0] === 'env' || words[0] === 'time' || words[0] === 'command') words.shift()
  const program = (words[0] ?? '').split('/').pop() ?? ''
  if (program === '') return '?'
  const sub = words.slice(1).find(word => !word.startsWith('-'))

  return WITH_SUBCOMMAND.has(program) && sub !== undefined ? `${program} ${sub}` : program
}

const LIMIT_WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }

export type LimitForecast = {
  kind: string
  percent: number
  /** Percentage points per hour. */
  rate: number
  /** When the window reaches 100% at that rate; undefined when it is not climbing. */
  fullAt?: number
  resetAt?: number
  /** True when the window fills before it resets. */
  isShort: boolean
  /** Where the rate came from: recent readings, or the window's average so far. */
  basis: 'recent' | 'window'
}

/**
 * Projects each rate-limit window to 100%: from the readings of the last hour
 * when they moved, else from the window's average since it opened.
 */
export const forecastLimits = (usage: UsageSnap | null, samples: Record<string, LimitSample[]>, now: number): LimitForecast[] =>
  (usage?.rateLimits ?? []).map(limit => {
    const resetAt = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt)
    const recent = (samples[limit.kind] ?? []).filter(sample => now - sample.at <= 3_600_000)
    const first = recent[0]
    const last = recent[recent.length - 1]
    let rate = 0
    let basis: LimitForecast['basis'] = 'window'
    if (first !== undefined && last !== undefined && last.at - first.at >= 5 * 60_000 && last.percent > first.percent) {
      rate = ((last.percent - first.percent) / (last.at - first.at)) * 3_600_000
      basis = 'recent'
    } else {
      const length = LIMIT_WINDOW_MS[limit.kind]
      if (length !== undefined && resetAt !== undefined && !Number.isNaN(resetAt)) {
        const elapsed = length - (resetAt - now)
        if (elapsed > 60_000) rate = (limit.percentUsed / elapsed) * 3_600_000
      }
    }
    const fullAt = rate > 0 ? now + ((100 - limit.percentUsed) / rate) * 3_600_000 : undefined
    const isShort = fullAt !== undefined && resetAt !== undefined && !Number.isNaN(resetAt) && fullAt < resetAt

    return { kind: limit.kind, percent: limit.percentUsed, rate, fullAt, resetAt, isShort, basis }
  })

export type TimeSplit = { model: number; tools: number; idle: number; total: number }

/** Session time in three parts: the model working, its tools running, and the wait for the person. */
export const timeSplit = (timing: Timing, startedAt: number, now: number): TimeSplit => {
  const total = startedAt > 0 ? Math.max(now - startedAt, timing.turnMs) : timing.turnMs
  const tools = Math.min(timing.toolMs, timing.turnMs)

  return { model: Math.max(0, timing.turnMs - tools), tools, idle: Math.max(0, total - timing.turnMs), total }
}

/** The local calendar day of a moment, as `YYYY-MM-DD`. */
export const dayKey = (time: number): string => {
  const date = new Date(time)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

const ZERO_DAY: DayStat = { usd: 0, tokensIn: 0, tokensOut: 0, turns: 0 }

/** The last `count` days ending today, oldest first, a zero day where nothing was recorded. */
export const recentDays = (days: Record<string, DayStat>, now: number, count: number): { key: string; day: DayStat }[] =>
  Array.from({ length: count }, (_, i) => {
    const key = dayKey(now - (count - 1 - i) * 86_400_000)

    return { key, day: days[key] ?? ZERO_DAY }
  })

/**
 * One session's share of one day. `base` is what the session had cost when it
 * was first seen that day: 0 for a session started that day, so cost spent
 * before the mod loaded still counts; its running total at midnight otherwise.
 */
export type SessionDay = DayStat & { base: number }

/** Every session's share of every day, keyed by day then session id: the shared file's shape. */
export type DayBook = Record<string, Record<string, SessionDay>>

const isDayStat = (value: unknown): value is SessionDay =>
  typeof value === 'object' &&
  value !== null &&
  ['usd', 'tokensIn', 'tokensOut', 'turns', 'base'].every(key => typeof (value as Record<string, unknown>)[key] === 'number')

/** Reads the shared file's text, dropping anything malformed rather than trusting it. */
export const parseDayBook = (text: string | undefined): DayBook => {
  try {
    const raw: unknown = JSON.parse(text ?? '{}')
    if (typeof raw !== 'object' || raw === null) return {}
    const book: DayBook = {}
    for (const [day, sessions] of Object.entries(raw)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof sessions !== 'object' || sessions === null) continue
      const kept = Object.entries(sessions).filter(([, stat]) => isDayStat(stat))
      if (kept.length > 0) book[day] = Object.fromEntries(kept) as Record<string, SessionDay>
    }

    return book
  } catch {
    return {}
  }
}

export type SessionChange = {
  /** The session's running cost now, when known: its day's usd is set from it. */
  usd?: number
  /** Whether the session started on this day, so its whole cost belongs to it. */
  isStartDay: boolean
  tokensIn?: number
  tokensOut?: number
  turns?: number
}

/** Updates one session's share of a day and keeps the newest 31 days. */
export const touchDay = (book: DayBook, day: string, session: string, change: SessionChange): DayBook => {
  const sessions = book[day] ?? {}
  const was = sessions[session]
  const base = was?.base ?? (change.isStartDay || change.usd === undefined ? 0 : change.usd)
  const now: SessionDay = {
    base,
    usd: change.usd === undefined ? (was?.usd ?? 0) : Math.max(0, change.usd - base),
    tokensIn: (was?.tokensIn ?? 0) + (change.tokensIn ?? 0),
    tokensOut: (was?.tokensOut ?? 0) + (change.tokensOut ?? 0),
    turns: (was?.turns ?? 0) + (change.turns ?? 0),
  }
  const next = { ...book, [day]: { ...sessions, [session]: now } }

  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-31))
}

/** Adds every session's share up, day by day. */
export const sumDays = (book: DayBook): Record<string, DayStat> =>
  Object.fromEntries(
    Object.entries(book).map(([day, sessions]) => [
      day,
      Object.values(sessions).reduce(
        (sum, one) => ({
          usd: sum.usd + one.usd,
          tokensIn: sum.tokensIn + one.tokensIn,
          tokensOut: sum.tokensOut + one.tokensOut,
          turns: sum.turns + one.turns,
        }),
        ZERO_DAY,
      ),
    ]),
  )

/** A path as the person thinks of it: relative to the session's folder when inside it. */
export const shortPath = (path: string, cwd: string): string =>
  cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path.replace(/^\/home\/[^/]+/, '~')

export type FileRow = { path: string } & FileStat

export const hotFiles = (files: Record<string, FileStat>): FileRow[] =>
  Object.entries(files)
    .map(([path, stat]) => ({ path, ...stat }))
    .sort((a, b) => b.reads + b.edits * 2 - (a.reads + a.edits * 2) || b.lastAt - a.lastAt)

export type CommandRow = { name: string } & CommandStat

export const busyCommands = (commands: Record<string, CommandStat>): CommandRow[] =>
  Object.entries(commands)
    .map(([name, stat]) => ({ name, ...stat }))
    .sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls)
