import type { ClientModule, ClientPointerEvent, JsonValue } from 'claude-code'

import type { PanelId, SortKey } from '../types'
import { brailleGraph, cacheHit, compact, duration, limitLabel, resetsIn, spark } from './format'
import type { Action, Snapshot } from './model'
import {
  busyCommands,
  dayKey,
  deltas,
  elapsedShare,
  forecastLimits,
  hotFiles,
  LEFT_PANELS,
  pace,
  PANELS,
  panelNumber,
  perHour,
  recentDays,
  shortModel,
  shortPath,
  sortedTools,
  SORTS,
  timeSplit,
} from './model'

// The terminal's drawing of cctop: btop's boxes, braille graphs, the mouse and keys.

const C = {
  frame: '#5c6370',
  frameHot: '#abb2bf',
  accent: '#d97757',
  low: '#98c379',
  mid: '#e5c07b',
  high: '#e06c75',
  blue: '#61afef',
  violet: '#c678dd',
  cyan: '#56b6c2',
}

const SUPERSCRIPT = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹']
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const WIDE = 100
const MAX_TOOLS = 12
const MAX_AGENTS = 8

type Seg = { t: string; c?: string; b?: boolean; d?: boolean; hit?: string }
type Line = Seg[]
type Local = { hover?: string; menu: boolean; tick: number }
type Hit = { id: string; y: number; from: number; to: number }

const heat = (percent: number): string => (percent >= 85 ? C.high : percent >= 60 ? C.mid : C.low)

const width = (line: Line): number => line.reduce((sum, seg) => sum + [...seg.t].length, 0)

/** Cuts or pads a line to exactly `size` cells, an ellipsis where it was cut. */
const fit = (line: Line, size: number): Line => {
  const out: Line = []
  let left = size
  for (const seg of line) {
    if (left <= 0) break
    const chars = [...seg.t]
    if (chars.length <= left) {
      out.push(seg)
      left -= chars.length
    } else {
      out.push({ ...seg, t: `${chars.slice(0, Math.max(0, left - 1)).join('')}…` })
      left = 0
    }
  }
  if (left > 0) out.push({ t: ' '.repeat(left) })

  return out
}

const pad = (text: string, size: number, align: 'left' | 'right' = 'left'): string => {
  const chars = [...text]
  if (chars.length > size) return `${chars.slice(0, Math.max(0, size - 1)).join('')}…`

  return align === 'left' ? text.padEnd(size) : text.padStart(size)
}

/**
 * Packs segments into rows of at most `size` cells, breaking only between
 * segments; a leading space is dropped where a row breaks.
 */
const wrapLine = (line: Line, size: number): Line[] => {
  const rows: Line[] = [[]]
  let used = 0
  for (const seg of line) {
    const span = [...seg.t].length
    if (used > 0 && used + span > size) {
      rows.push([])
      used = 0
      const trimmed = seg.t.replace(/^ +/, '')
      if (trimmed.length === 0) continue
      rows[rows.length - 1]?.push({ ...seg, t: trimmed })
      used = [...trimmed].length
      continue
    }
    rows[rows.length - 1]?.push(seg)
    used += span
  }

  return rows.map(row => fit(row, size))
}

/** Packs whole items into rows of at most `size` cells, `gap` cells apart; an item never splits. */
const wrapItems = (items: readonly Line[], size: number, gap = 2): Line[] => {
  const rows: Line[] = []
  let row: Line = []
  for (const item of items) {
    const needed = width(row) === 0 ? width(item) : width(row) + gap + width(item)
    if (width(row) > 0 && needed > size) {
      rows.push(fit(row, size))
      row = []
    }
    row = width(row) === 0 ? [...item] : [...row, { t: ' '.repeat(gap) }, ...item]
  }
  if (width(row) > 0) rows.push(fit(row, size))

  return rows
}

/** A gauge of `size` cells: the used share in its heat colour, an optional tick where an even spend would be. */
const gauge = (share: number, size: number, color: string, marker?: number): Line => {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * size)
  const at = marker === undefined ? -1 : Math.min(size - 1, Math.max(0, Math.round(marker * size)))
  const line: Line = []
  for (let i = 0; i < size; i += 1) {
    const seg: Seg = i === at ? { t: '│', c: '#dcdfe4', b: true } : i < filled ? { t: '■', c: color } : { t: '■', c: '#3e4451' }
    const last = line[line.length - 1]
    if (last !== undefined && last.c === seg.c && last.b === seg.b) last.t += seg.t
    else line.push(seg)
  }

  return line
}

type Panel = {
  id: PanelId
  /** The superscript in the title; `layout` sets it from the panel's place in PANELS. */
  num: number
  right: Line
  summary: Line
  body: Line[]
  footer?: Line
}

const frame = (panel: Panel, size: number, local: Local, collapsed: boolean): Line[] => {
  const isHot = local.hover !== undefined && local.hover.endsWith(`:${panel.id}`)
  const edge = isHot ? C.frameHot : C.frame
  const hit = `collapse:${panel.id}`
  const title: Line = [
    { t: sup(panel.num), c: C.accent },
    { t: panel.id, b: true, hit },
    { t: collapsed ? ' ▸' : ' ▾', d: true, hit },
  ]
  let right = collapsed ? panel.summary : panel.right
  if (size - 4 - width(title) - (width(right) + 2) < 1) right = []
  const rightPart: Line = right.length > 0 ? [{ t: ' ' }, ...right, { t: ' ' }] : []
  const fill = Math.max(0, size - 4 - width(title) - width(rightPart))
  const [open, close] = collapsed ? ['╶─', '─╴'] : ['╭─', '─╮']
  const top: Line = fit([{ t: open, c: edge }, ...title, { t: '─'.repeat(fill), c: edge }, ...rightPart, { t: close, c: edge }], size)
  if (collapsed) return [top]

  const body = panel.body.map(line => [{ t: '│ ', c: edge }, ...fit(line, size - 4), { t: ' │', c: edge }])
  const footer = panel.footer ?? []
  const bottom: Line = fit(
    [{ t: '╰─', c: edge }, ...footer, { t: '─'.repeat(Math.max(0, size - 4 - width(footer))), c: edge }, { t: '─╯', c: edge }],
    size,
  )

  return [top, ...body, bottom]
}

const contextPanel = (p: Snapshot, inner: number, graphRows: number): Panel => {
  const usage = p.usage
  const percent = usage?.percent
  const amount = usage === null ? '' : `${compact(usage.tokens ?? 0)}/${compact(usage.window)}`
  if (percent === undefined) {
    return { id: 'context', num: 0, right: [], summary: [{ t: 'waiting', d: true }], body: [[{ t: 'waiting for the first response', d: true }]] }
  }
  // The graph grows a row per four turns up to its full height, so a fresh session has no empty block.
  const rows = Math.min(graphRows, 1 + Math.floor(p.history.length / 4))
  const graph = p.history.length < 2 ? [] : brailleGraph(p.history, inner, rows)
  const body: Line[] = graph.map((row, i) => [{ t: row, c: heat(((rows - i) / rows) * 100) }])
  const label = pad(`${Math.round(percent)}%`, 5, 'right')
  body.push([...gauge(percent / 100, inner - 6, heat(percent)), { t: label, b: true }])

  return {
    id: 'context',
    num: 0,
    right: [{ t: amount, d: true }],
    summary: [{ t: `${Math.round(percent)}%`, c: heat(percent), b: true }, { t: ` ${amount}`, d: true }],
    body,
  }
}

const limitsPanel = (p: Snapshot, inner: number, now: number): Panel => {
  const limits = p.usage?.rateLimits ?? []
  if (limits.length === 0) {
    return { id: 'limits', num: 0, right: [], summary: [{ t: 'no reading', d: true }], body: [[{ t: 'no reading yet', d: true }]] }
  }
  const body: Line[] = limits.map(limit => {
    const ahead = pace(limit.kind, limit.percentUsed, limit.resetsAt, now)
    const paceText = ahead === undefined ? '' : Math.abs(ahead) < 1 ? '=' : ahead > 0 ? `▲${Math.round(ahead)}` : `▼${Math.round(-ahead)}`
    const percentSeg: Seg = { t: pad(`${Math.round(limit.percentUsed)}%`, 5, 'right'), b: true }
    const resetSeg: Seg = { t: pad(`↻${resetsIn(limit.resetsAt, now)}`, 8, 'right'), d: true }
    const paceSeg: Seg = { t: pad(paceText, 5, 'right'), c: ahead === undefined || ahead <= 0 ? C.low : ahead > 10 ? C.high : C.mid }
    // The gauge keeps 8 cells at least: pace goes first, then the reset time.
    const tails: Line[] = [[percentSeg, resetSeg, paceSeg], [percentSeg, resetSeg], [percentSeg]]
    const tail = tails.find(one => inner - 4 - width(one) >= 8) ?? [percentSeg]
    const size = Math.max(4, inner - 4 - width(tail))

    return [
      { t: pad(limitLabel(limit.kind), 4), c: C.cyan, b: true },
      ...gauge(limit.percentUsed / 100, size, heat(limit.percentUsed), elapsedShare(limit.kind, limit.resetsAt, now)),
      ...tail,
    ]
  })
  const summary: Line = limits.flatMap((limit, i) => [
    { t: `${i === 0 ? '' : ' '}${limitLabel(limit.kind)} `, d: true },
    { t: `${Math.round(limit.percentUsed)}%`, c: heat(limit.percentUsed), b: true },
  ])

  return { id: 'limits', num: 0, right: [{ t: '│ = even pace', d: true }], summary, body }
}

const costPanel = (p: Snapshot, inner: number, now: number): Panel => {
  const usd = p.usage?.costUsd
  const rate = perHour(usd, p.startedAt, now)
  const hit = cacheHit(p.tokens)
  const body: Line[] = [
    [
      { t: usd === undefined ? '$-' : `$${usd.toFixed(2)}`, c: C.accent, b: true },
      { t: rate === undefined ? '' : `  $${rate.toFixed(2)}/h`, d: true },
      { t: `  ${p.tokens.turns} ${p.tokens.turns === 1 ? 'turn' : 'turns'}`, d: true },
    ],
  ]
  // One bar a turn from the left edge, the newest on the right; the scale is the dearest turn shown.
  const spent = deltas(p.costs)
  if (spent.length > 0) {
    const size = Math.max(4, inner - 20)
    const shown = spent.slice(-size)
    const top = Math.max(...shown, 1e-9)
    body.push([
      { t: 'per turn ', d: true },
      { t: spark(shown, size, top).padEnd(size), c: C.violet },
      { t: pad(`max $${top.toFixed(2)}`, 11, 'right'), d: true },
    ])
  }
  body.push([
    { t: 'in ', d: true },
    { t: compact(p.tokens.input + p.tokens.cacheRead + p.tokens.cacheWrite), b: true },
    { t: '  out ', d: true },
    { t: compact(p.tokens.output), b: true },
  ])
  body.push(
    hit === undefined
      ? [{ t: 'cache ', d: true }, { t: '-', d: true }]
      : [
          { t: 'cache ', d: true },
          ...gauge(hit, Math.max(4, inner - 11), hit >= 0.8 ? C.low : hit >= 0.5 ? C.mid : C.high),
          { t: pad(`${Math.round(hit * 100)}%`, 5, 'right'), b: true },
        ],
  )

  return {
    id: 'cost',
    num: 0,
    right: rate === undefined ? [] : [{ t: `$${rate.toFixed(2)}/h`, d: true }],
    summary: [
      { t: usd === undefined ? '$-' : `$${usd.toFixed(2)}`, c: C.accent, b: true },
      { t: hit === undefined ? '' : ` cache ${Math.round(hit * 100)}%`, d: true },
    ],
    body,
  }
}

type Column = { key: (typeof SORTS)[number]; label: string; size: number; value: (row: ReturnType<typeof sortedTools>[number]) => string }

// Every duration `duration` prints is 5 cells at most, so 6 holds it with a gap.
const COLUMNS: Column[] = [
  { key: 'calls', label: 'calls', size: 7, value: row => String(row.calls) },
  { key: 'errors', label: 'err', size: 4, value: row => String(row.errors + row.denied) },
  { key: 'avg', label: 'avg', size: 6, value: row => duration(row.totalMs / Math.max(1, row.calls)) },
  { key: 'time', label: 'total', size: 7, value: row => duration(row.totalMs) },
  { key: 'max', label: 'max', size: 6, value: row => duration(row.maxMs) },
]

const COLUMNS_SIZE = COLUMNS.reduce((sum, column) => sum + column.size, 0)

// Narrower than this, a tool takes two rows instead of losing columns.
const MIN_NAME = 8

const toolsPanel = (p: Snapshot, inner: number, local: Local): Panel => {
  const rows = sortedTools(p.tools, p.prefs.sort, p.prefs.reverse)
  const calls = rows.reduce((sum, row) => sum + row.calls, 0)
  const errors = rows.reduce((sum, row) => sum + row.errors + row.denied, 0)
  const right: Line = [{ t: `${calls} calls`, d: true }]
  const summary: Line = [
    { t: `${calls} calls`, b: true },
    { t: ` ${errors} err`, c: errors > 0 ? C.high : undefined, d: errors === 0 },
  ]
  if (rows.length === 0) {
    return { id: 'tools', num: 0, right, summary, body: [[{ t: 'no tool calls yet', d: true }]] }
  }

  const arrow = (key: string) => (p.prefs.sort === key ? (p.prefs.reverse ? '▲' : '▼') : '')
  const header = (key: string, label: string, size: number, align: 'left' | 'right'): Seg => {
    const id = `sort:${key}`
    const isOn = p.prefs.sort === key

    return { t: pad(`${label}${arrow(key)}`, size, align), hit: id, c: isOn ? C.accent : undefined, d: !isOn && local.hover !== id, b: isOn }
  }
  const body: Line[] = []
  const shown = rows.slice(0, MAX_TOOLS)

  if (inner - COLUMNS_SIZE >= MIN_NAME) {
    const nameSize = inner - COLUMNS_SIZE
    body.push([header('name', 'tool', nameSize, 'left'), ...COLUMNS.map(column => header(column.key, column.label, column.size, 'right'))])
    for (const row of shown) {
      const failed = row.errors + row.denied
      body.push([
        { t: pad(row.name, nameSize), c: C.blue },
        ...COLUMNS.map(column => ({
          t: pad(column.value(row), column.size, 'right'),
          c: column.key === 'errors' && failed > 0 ? C.high : undefined,
          d: column.key === 'errors' && failed === 0,
        })),
      ])
    }
  } else {
    // Too narrow for a table: the sort keys wrap as a row of their own, each tool takes two rows.
    const keys: Seg[] = [
      { t: 'sort ', d: true },
      header('name', 'name', 4 + arrow('name').length, 'left'),
      ...COLUMNS.flatMap(column => [{ t: ' ' }, header(column.key, column.label, column.label.length + arrow(column.key).length, 'left')]),
    ]
    body.push(...wrapLine(keys, inner))
    for (const row of shown) {
      const failed = row.errors + row.denied
      const count = `${row.calls}×`
      body.push([
        { t: pad(row.name, Math.max(1, inner - count.length - 1)), c: C.blue },
        { t: ` ${count}`, b: true },
      ])
      body.push([
        { t: '  ' },
        ...(failed > 0 ? [{ t: `err ${failed}  `, c: C.high }] : []),
        { t: 'avg ', d: true },
        { t: duration(row.totalMs / Math.max(1, row.calls)) },
        { t: ' Σ ', d: true },
        { t: duration(row.totalMs) },
        { t: ' max ', d: true },
        { t: duration(row.maxMs) },
      ])
    }
  }

  return {
    id: 'tools',
    num: 0,
    right,
    summary,
    body,
    footer: rows.length > MAX_TOOLS ? [{ t: ` +${rows.length - MAX_TOOLS} more `, d: true }] : undefined,
  }
}

const agentsPanel = (p: Snapshot, inner: number, now: number, tick: number): Panel => {
  const running = p.agents.filter(agent => agent.status === 'running').length
  const done = p.agents.length - running
  const right: Line = [
    { t: `${running} running`, c: running > 0 ? C.mid : undefined, d: running === 0 },
    { t: ` · ${done} done`, d: true },
  ]
  if (p.agents.length === 0) {
    return { id: 'agents', num: 0, right: [], summary: [{ t: 'none', d: true }], body: [[{ t: 'no subagents yet', d: true }]] }
  }
  const shown = [...p.agents]
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
    .slice(0, MAX_AGENTS)
  const glyph = { running: SPINNER[tick % SPINNER.length] ?? '•', completed: '●', failed: '✕', killed: '○' }
  const color = { running: C.mid, completed: C.low, failed: C.high, killed: C.frame }
  // Narrow panes lose the model column first; the description takes what is left.
  const typeSize = Math.max(6, Math.min(16, inner - 2 - 7 - (inner >= 44 ? 10 : 0)))
  const body: Line[] = shown.map(agent => [
    { t: `${glyph[agent.status]} `, c: color[agent.status] },
    { t: pad(agent.type, typeSize), b: true },
    ...(inner >= 44 ? [{ t: pad(shortModel(agent.model), 10), c: C.cyan }] : []),
    {
      t: pad(duration(agent.status === 'running' ? now - agent.startedAt : (agent.durationMs ?? 0)), 7, 'right'),
      d: true,
    },
    { t: `  ${agent.description}`, d: true },
  ])

  return { id: 'agents', num: 0, right, summary: right, body: inner > 0 ? body : [] }
}

const sup = (n: number): string => SUPERSCRIPT[n % 10] ?? ''

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const hhmm = (time: number, now: number): string => {
  const date = new Date(time)
  const at = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  return time - now < 20 * 3_600_000 ? at : `${WEEKDAYS[date.getDay()] ?? ''} ${at}`
}

/** Keeps the end of a path, where its name is, when it does not fit. */
const tail = (text: string, size: number): string => {
  const chars = [...text]

  return chars.length <= size ? text.padEnd(size) : `…${chars.slice(chars.length - size + 1).join('')}`
}

// Forecast columns after the window's name: what the table shows once there is room.
const FORECAST_COLUMNS = [
  { label: 'used', size: 6 },
  { label: 'rate/h', size: 8 },
  { label: 'full at', size: 10 },
  { label: 'reset', size: 10 },
]
const FORECAST_SIZE = 4 + FORECAST_COLUMNS.reduce((sum, column) => sum + column.size, 0)
const STATUS_SIZE = 14

const forecastPanel = (p: Snapshot, inner: number, now: number): Panel => {
  const rows = forecastLimits(p.usage, p.samples, now)
  if (rows.length === 0) {
    return { id: 'forecast', num: 0, right: [], summary: [{ t: 'no reading', d: true }], body: [[{ t: 'no rate-limit reading yet', d: true }]] }
  }
  // `~` marks a rate taken from the window's average, when the last hour did not move.
  const rateOf = (row: (typeof rows)[number]) => (row.rate > 0 ? `${row.basis === 'window' ? '~' : ''}${row.rate.toFixed(1)}%` : 'flat')
  const status = (row: (typeof rows)[number]): Seg =>
    row.fullAt === undefined
      ? { t: '· flat', d: true }
      : row.isShort && row.resetAt !== undefined
        ? { t: `✕ ${duration(row.resetAt - row.fullAt)} early`, c: C.high, b: true }
        : { t: '✓ lasts', c: C.low }
  const body: Line[] = []

  if (inner >= FORECAST_SIZE + STATUS_SIZE) {
    body.push([
      { t: pad('', 4) },
      ...FORECAST_COLUMNS.map(column => ({ t: pad(column.label, column.size, 'right'), d: true })),
      { t: pad('', 2) },
      { t: 'status', d: true },
    ])
    for (const row of rows) {
      body.push([
        { t: pad(limitLabel(row.kind), 4), c: C.cyan, b: true },
        { t: pad(`${Math.round(row.percent)}%`, 6, 'right'), c: heat(row.percent), b: true },
        { t: pad(rateOf(row), 8, 'right') },
        { t: pad(row.fullAt === undefined ? '-' : hhmm(row.fullAt, now), 10, 'right'), b: row.isShort },
        { t: pad(row.resetAt === undefined ? '-' : hhmm(row.resetAt, now), 10, 'right'), d: true },
        { t: pad('', 2) },
        status(row),
      ])
    }
  } else {
    // Narrow: a window takes two rows, as a tool does in the tools panel.
    for (const row of rows) {
      const state = status(row)
      body.push([
        { t: pad(limitLabel(row.kind), 4), c: C.cyan, b: true },
        { t: `${Math.round(row.percent)}% `, c: heat(row.percent), b: true },
        { t: pad(`${rateOf(row)}/h`, Math.max(1, inner - 4 - `${Math.round(row.percent)}% `.length - [...state.t].length)) },
        state,
      ])
      body.push([
        { t: '    full ', d: true },
        { t: row.fullAt === undefined ? '-' : hhmm(row.fullAt, now), b: row.isShort },
        { t: '  reset ', d: true },
        { t: row.resetAt === undefined ? '-' : hhmm(row.resetAt, now) },
      ])
    }
  }
  const worst = rows.find(row => row.isShort)

  return {
    id: 'forecast',
    num: 0,
    right: [{ t: '~ window avg', d: true }],
    summary:
      worst === undefined
        ? [{ t: '✓ lasts', c: C.low }]
        : [{ t: `✕ ${limitLabel(worst.kind)} full ${worst.fullAt === undefined ? '' : hhmm(worst.fullAt, now)}`, c: C.high }],
    body,
  }
}

const timePanel = (p: Snapshot, inner: number, now: number): Panel => {
  const split = timeSplit(p.timing, p.startedAt, now)
  if (split.total <= 0) {
    return { id: 'time', num: 0, right: [], summary: [{ t: 'no turns', d: true }], body: [[{ t: 'no finished turn yet', d: true }]] }
  }
  const parts = [
    { label: 'model', ms: split.model, color: C.violet },
    { label: 'tools', ms: split.tools, color: C.blue },
    { label: 'you', ms: split.idle, color: C.frame },
  ]
  const cells = parts.map(part => Math.round((part.ms / split.total) * inner))
  // Rounding may leave the bar a cell short or long; the waiting part absorbs it.
  cells[2] = Math.max(0, inner - (cells[0] ?? 0) - (cells[1] ?? 0))
  const share = (ms: number) => `${Math.round((ms / split.total) * 100)}%`
  const avg = p.timing.turns > 0 ? p.timing.turnMs / p.timing.turns : 0

  return {
    id: 'time',
    num: 0,
    right: [{ t: `avg turn ${duration(avg)}`, d: true }],
    summary: [
      { t: `model ${share(split.model)}`, c: C.violet },
      { t: ` tools ${share(split.tools)}`, c: C.blue },
    ],
    body: [
      parts.map((part, i) => ({ t: '■'.repeat(cells[i] ?? 0), c: part.color })),
      ...wrapItems(
        parts.map(part => [
          { t: '■ ', c: part.color },
          { t: `${part.label} `, d: true },
          { t: `${share(part.ms)} ${duration(part.ms)}`, b: true },
        ]),
        inner,
      ),
    ],
  }
}

const filesPanel = (p: Snapshot, inner: number): Panel => {
  const rows = hotFiles(p.files)
  const right: Line = [{ t: `${rows.length} files`, d: true }]
  if (rows.length === 0) {
    return { id: 'files', num: 0, right: [], summary: [{ t: 'none', d: true }], body: [[{ t: 'no file read or changed yet', d: true }]] }
  }
  const pathSize = Math.max(4, inner - 11)
  const body: Line[] = [[{ t: pad('read', 4, 'right'), d: true }, { t: pad('edit', 5, 'right'), d: true }, { t: '  path', d: true }]]
  for (const row of rows.slice(0, 10)) {
    body.push([
      { t: pad(row.reads === 0 ? '·' : String(row.reads), 4, 'right'), c: C.blue },
      { t: pad(row.edits === 0 ? '·' : String(row.edits), 5, 'right'), c: C.accent, b: row.edits > 0 },
      { t: '  ' },
      { t: tail(shortPath(row.path, p.cwd), pathSize) },
    ])
  }
  const top = rows[0]

  return {
    id: 'files',
    num: 0,
    right,
    summary: top === undefined ? [] : [{ t: shortPath(top.path, p.cwd).split('/').pop() ?? '', c: C.blue }],
    body,
    footer: rows.length > 10 ? [{ t: ` +${rows.length - 10} more `, d: true }] : undefined,
  }
}

const bashPanel = (p: Snapshot, inner: number): Panel => {
  const rows = busyCommands(p.commands)
  const calls = rows.reduce((sum, row) => sum + row.calls, 0)
  if (rows.length === 0) {
    return { id: 'bash', num: 0, right: [], summary: [{ t: 'none', d: true }], body: [[{ t: 'no shell command yet', d: true }]] }
  }
  const nameSize = Math.max(6, inner - 17)
  const body: Line[] = [
    [{ t: pad('command', nameSize), d: true }, { t: pad('runs', 6, 'right'), d: true }, { t: pad('err', 4, 'right'), d: true }, { t: pad('time', 7, 'right'), d: true }],
  ]
  for (const row of rows.slice(0, 10)) {
    body.push([
      { t: pad(row.name, nameSize), c: C.cyan },
      { t: pad(String(row.calls), 6, 'right') },
      { t: pad(String(row.errors), 4, 'right'), c: row.errors > 0 ? C.high : undefined, d: row.errors === 0 },
      { t: pad(duration(row.totalMs), 7, 'right'), d: true },
    ])
  }

  return {
    id: 'bash',
    num: 0,
    right: [{ t: `${calls} runs`, d: true }],
    summary: [{ t: rows[0]?.name ?? '', c: C.cyan }],
    body,
    footer: rows.length > 10 ? [{ t: ` +${rows.length - 10} more `, d: true }] : undefined,
  }
}

const weekPanel = (p: Snapshot, inner: number, now: number): Panel => {
  const list = recentDays(p.days, now, 7)
  const total = list.reduce((sum, { day }) => sum + day.usd, 0)
  const byCost = list.some(({ day }) => day.usd > 0)
  const value = (day: (typeof list)[number]['day']) => (byCost ? day.usd : day.tokensIn + day.tokensOut)
  const top = Math.max(1e-9, ...list.map(({ day }) => value(day)))
  const showTokens = inner >= 36
  const barSize = Math.max(4, inner - 6 - 8 - (showTokens ? 7 : 0))
  const today = dayKey(now)
  const body: Line[] = list.map(({ key, day }) => {
    const isToday = key === today
    const filled = Math.round((value(day) / top) * barSize)

    return [
      { t: `${WEEKDAYS[new Date(`${key}T12:00:00`).getDay()] ?? ''} ${key.slice(8)} `, c: isToday ? C.accent : undefined, b: isToday, d: !isToday },
      { t: '■'.repeat(filled), c: isToday ? C.accent : C.violet },
      { t: '■'.repeat(barSize - filled), c: '#3e4451' },
      { t: pad(day.usd > 0 ? `$${day.usd.toFixed(2)}` : '-', 8, 'right'), b: isToday },
      ...(showTokens ? [{ t: pad(day.tokensIn + day.tokensOut > 0 ? compact(day.tokensIn + day.tokensOut) : '', 7, 'right'), d: true }] : []),
    ]
  })

  return {
    id: 'week',
    num: 0,
    right: [{ t: `7d $${total.toFixed(2)}`, d: true }],
    summary: [{ t: `7d $${total.toFixed(2)}`, c: C.accent }],
    body,
  }
}

const menuPanel = (p: Snapshot, local: Local, inner: number): Line[] => {
  const item = (panel: (typeof PANELS)[number], size: number): Line => {
    const id = `visible:${panel.id}`
    const isOn = !p.prefs.hidden.includes(panel.id)
    const isHot = local.hover === id

    return fit(
      [
        { t: isOn ? '[x] ' : '[ ] ', c: isOn ? C.low : C.frame, hit: id },
        { t: sup(panelNumber(panel.id)), c: C.accent, hit: id },
        { t: pad(panel.title, 9), b: isHot, hit: id },
        { t: panel.about, d: !isHot, hit: id },
      ],
      size,
    )
  }
  const defaults = PANELS.filter(panel => panel.isDefault)
  const optional = PANELS.filter(panel => !panel.isDefault)
  const rows: Line[] = []

  // Two columns, read top to bottom: the default set on the left, the optional panels on the right.
  if (inner >= 64) {
    const half = Math.floor(inner / 2)
    rows.push([{ t: pad('default', half), d: true }, { t: 'optional', d: true }])
    for (let i = 0; i < Math.max(defaults.length, optional.length); i += 1) {
      const left = defaults[i]
      const right = optional[i]
      rows.push([...(left === undefined ? [{ t: ' '.repeat(half) }] : item(left, half)), ...(right === undefined ? [] : item(right, inner - half))])
    }
  } else {
    rows.push([{ t: 'default', d: true }], ...defaults.map(panel => item(panel, inner)))
    rows.push([{ t: 'optional', d: true }], ...optional.map(panel => item(panel, inner)))
  }

  const option = (id: string, label: string, value: string): Line => [
    { t: pad(label, 14), d: true },
    { t: `[ ${value} ]`, c: C.accent, b: local.hover === id, hit: id },
  ]
  rows.push([{ t: ' ' }], [{ t: 'context alert', d: true }])
  rows.push(option('alert', '  speaks as', p.prefs.alert))
  rows.push(option('threshold', '  past', `${p.prefs.threshold}%`))
  rows.push([{ t: ' ' }], [{ t: 'reset layout', c: C.accent, hit: 'reset', b: local.hover === 'reset' }, { t: '  default panels, open, sorted by time', d: true }])

  return rows
}

/** Lays the panels out in one column, or two from 100 cells, and returns the lines top to bottom. */
const layout = (p: Snapshot, size: number, now: number, local: Local): Line[] => {
  const shown = PANELS.map(panel => panel.id).filter(id => !p.prefs.hidden.includes(id))
  const leftIds = shown.filter(id => LEFT_PANELS.includes(id))
  const rightIds = shown.filter(id => !LEFT_PANELS.includes(id))
  const isWide = size >= WIDE && leftIds.length > 0 && rightIds.length > 0
  const leftSize = isWide ? Math.floor(size / 2) : size
  const rightSize = isWide ? size - leftSize : size
  const graphRows = Math.min(8, Math.max(2, Math.floor((p.rows - 18) / (isWide ? 1 : 3))))
  const build = (id: PanelId, columnSize: number): Line[] => {
    const inner = columnSize - 4
    const panels: Record<PanelId, () => Panel> = {
      context: () => contextPanel(p, inner, graphRows),
      limits: () => limitsPanel(p, inner, now),
      cost: () => costPanel(p, inner, now),
      tools: () => toolsPanel(p, inner, local),
      agents: () => agentsPanel(p, inner, now, local.tick),
      forecast: () => forecastPanel(p, inner, now),
      time: () => timePanel(p, inner, now),
      files: () => filesPanel(p, inner),
      bash: () => bashPanel(p, inner),
      week: () => weekPanel(p, inner, now),
    }

    return frame({ ...panels[id](), num: panelNumber(id) }, columnSize, local, p.prefs.collapsed.includes(id))
  }

  const lines: Line[] = []
  if (local.menu) {
    const menu: Panel = { id: 'context', num: 0, right: [], summary: [], body: menuPanel(p, local, size - 4) }
    const drawn = frame(menu, size, { menu: true, tick: 0 }, false)
    drawn[0] = fit([{ t: '╭─', c: C.accent }, { t: 'menu', b: true, c: C.accent, hit: 'menu' }, { t: '─'.repeat(Math.max(0, size - 8)), c: C.accent }, { t: '─╮', c: C.accent }], size)
    lines.push(...drawn)
  }

  if (!isWide) {
    for (const id of shown) lines.push(...build(id, size))

    return lines
  }

  const left = leftIds.flatMap(id => build(id, leftSize))
  const right = rightIds.flatMap(id => build(id, rightSize))
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    lines.push([...(left[i] ?? [{ t: ' '.repeat(leftSize) }]), ...(right[i] ?? [{ t: ' '.repeat(rightSize) }])])
  }

  return lines
}

const clock = (time: number): string => {
  const date = new Date(time)

  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const topBar = (p: Snapshot, size: number, now: number, local: Local): Line => {
  const left: Line = [
    { t: ' cctop ', c: C.accent, b: true },
    { t: shortModel(p.model), c: C.cyan },
    { t: p.startedAt > 0 ? `  up ${duration(Math.max(0, now - p.startedAt))}` : '', d: true },
  ]
  const menu: Seg = { t: local.menu ? '≡ close' : '≡ menu', hit: 'menu', c: local.hover === 'menu' || local.menu ? C.accent : undefined, b: local.hover === 'menu' }
  const right: Line = [{ t: clock(now), b: true }, { t: '  ' }, menu, { t: ' ' }]
  // What a narrow pane drops, in order: the uptime, the model, the clock; the menu stays.
  const lefts = [left, left.slice(0, 2), left.slice(0, 1)]
  const rights = [right, [menu, { t: ' ' }]]
  for (const r of rights) {
    for (const l of lefts) {
      if (width(l) + width(r) + 1 <= size) return fit([...l, { t: ' '.repeat(size - width(l) - width(r)) }, ...r], size)
    }
  }

  return fit([menu], size)
}

const HINT: Line[] = [
  [{ t: '1-0', c: C.accent }, { t: ' show/hide', d: true }],
  [{ t: 'click title', c: C.accent }, { t: ' fold', d: true }],
  [{ t: 'm', c: C.accent }, { t: ' menu', d: true }],
  [{ t: 's r', c: C.accent }, { t: ' sort', d: true }],
]

// The last drawing's clickable regions and props, for the pointer and key listeners.
let hits: Hit[] = []
let latest: Snapshot | undefined
let base = { props: 0, local: 0 }

const hitAt = (x: number, y: number): string | undefined =>
  hits.find(hit => hit.y === y && x >= hit.from && x < hit.to)?.id

const Top: ClientModule<JsonValue, Local> = (raw, surface) => {
  const p = raw as unknown as Snapshot
  latest = p
  const { Box, Text } = surface.elements
  const local: Local = surface.state ?? { menu: false, tick: 0 }

  // The hooks' clock drives the drawing; the frame clock only moves it on between their redraws.
  if (base.props !== p.now) base = { props: p.now, local: Date.now() }
  const now = p.now + Math.max(0, Date.now() - base.local)

  const act = (action: Action) => surface.post(action as unknown as JsonValue)
  const press = (id: string) => {
    const current = surface.state ?? local
    const [kind, arg] = id.split(':')
    if (kind === 'menu') surface.setState({ ...current, menu: !current.menu })
    else if (kind === 'reset' || kind === 'alert' || kind === 'threshold') act({ kind })
    else if (kind === 'collapse' && arg !== undefined) act({ kind: 'collapse', panel: arg as PanelId })
    else if (kind === 'visible' && arg !== undefined && latest !== undefined) {
      act({ kind: 'visible', panel: arg as PanelId, on: latest.prefs.hidden.includes(arg as PanelId) })
    } else if (kind === 'sort' && arg !== undefined) act({ kind: 'sort', key: arg as SortKey })
  }

  if (surface.state === undefined) {
    surface.every(1000, () => {
      const current = surface.state ?? local
      surface.setState({ ...current, tick: current.tick + 1 })
    })
    surface.onPointer((event: ClientPointerEvent) => {
      const current = surface.state ?? local
      const id = hitAt(event.x, event.y)
      if (event.type === 'leave') {
        if (current.hover !== undefined) surface.setState({ ...current, hover: undefined })
      } else if (event.type === 'move' || event.type === 'enter') {
        if (id !== current.hover) surface.setState({ ...current, hover: id })
      } else if (event.type === 'down' && event.button === 'left' && id !== undefined) {
        press(id)
      }
    })
    surface.onKey(event => {
      const current = surface.state ?? local
      // Digits 1-9 and 0 stand for the ten panels, as in btop.
      const panel = /^[0-9]$/.test(event.key) ? PANELS[(Number(event.key) + 9) % 10] : undefined
      if (panel !== undefined && latest !== undefined) {
        act({ kind: 'visible', panel: panel.id, on: latest.prefs.hidden.includes(panel.id) })
      } else if (event.key === 'm') surface.setState({ ...current, menu: !current.menu })
      else if (event.key === 's' && latest !== undefined) {
        const next = SORTS[(SORTS.indexOf(latest.prefs.sort) + 1) % SORTS.length] ?? 'time'
        act({ kind: 'sort', key: next })
      } else if (event.key === 'r' && latest !== undefined) act({ kind: 'sort', key: latest.prefs.sort })
    })
    surface.setState(local)
  }

  const size = Math.max(16, surface.columns > 0 ? surface.columns : p.columns)
  const lines = [topBar(p, size, now, local), ...layout(p, size, now, local), ...wrapItems(HINT, size - 1).map(row => [{ t: ' ' }, ...row])]

  hits = []
  lines.forEach((line, y) => {
    let x = 0
    for (const seg of line) {
      const span = [...seg.t].length
      if (seg.hit !== undefined) {
        const last = hits[hits.length - 1]
        if (last !== undefined && last.id === seg.hit && last.y === y && last.to === x) last.to = x + span
        else hits.push({ id: seg.hit, y, from: x, to: x + span })
      }
      x += span
    }
  })

  return (
    <Box flexDirection="column">
      {lines.map(line => (
        <Box height={1} overflow="hidden">
          {line.map(seg => {
            const isHover = seg.hit !== undefined && seg.hit === local.hover
            const style = {
              ...(seg.c === undefined ? {} : { color: seg.c }),
              ...(seg.b === true ? { bold: true } : {}),
              ...(seg.d === true ? { dimColor: true } : {}),
              ...(isHover ? { inverse: true } : {}),
            }

            return <Text {...style} wrap="truncate-end">{seg.t}</Text>
          })}
        </Box>
      ))}
    </Box>
  )
}

export default Top
