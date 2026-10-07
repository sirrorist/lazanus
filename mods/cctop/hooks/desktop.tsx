import type { Elements, RenderElement } from 'claude-code'

import type { PanelId } from '../types'
import { cacheHit, compact, duration, limitLabel, resetsIn } from './format'
import type { Action, Snapshot } from './model'
import {
  busyCommands,
  dayKey,
  deltas,
  elapsedShare,
  forecastLimits,
  hotFiles,
  pace,
  PANELS,
  perHour,
  recentDays,
  shortModel,
  shortPath,
  sortedTools,
  timeSplit,
} from './model'

// The desktop app's drawing of cctop: cards, native buttons and SVG charts.
//
// Every Svg is drawn as a plain image: `isInteractive` puts it in a sandboxed
// frame with a white page behind it, which shows on a dark theme. Text never
// goes inside an SVG either, since an image cannot follow the theme's colour.

type Kit = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>

// Mid tones that read on a light and a dark page alike.
const C = {
  accent: '#d97757',
  low: '#3fb950',
  mid: '#d29922',
  high: '#f85149',
  blue: '#58a6ff',
  violet: '#a371f7',
  grey: '#8b949e',
  track: 'rgba(127,127,127,0.22)',
}

// Pixels per cell of the code font, to size an SVG from the pane's width in cells.
const PX = 7.2

const heat = (percent: number): string => (percent >= 85 ? C.high : percent >= 60 ? C.mid : C.low)

const LABELS: Record<PanelId, string> = {
  context: 'Context',
  limits: 'Limits',
  cost: 'Cost',
  tools: 'Tools',
  agents: 'Agents',
  forecast: 'Forecast',
  time: 'Time',
  files: 'Files',
  bash: 'Bash',
  week: 'Week',
}

const svg = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/** The smallest of 10, 25, 50 and 100 that holds the values with some headroom: the chart's top. */
export const scaleTop = (values: readonly number[]): number => {
  const high = Math.max(0, ...values) * 1.15

  return [10, 25, 50, 100].find(top => high <= top) ?? 100
}

/** An area chart of percentages from 0 to `top`, one point a turn, the newest on the right. */
export const areaChart = (values: readonly number[], w: number, h: number, top = 100): string => {
  const shown = values.slice(-120)
  const color = heat(shown[shown.length - 1] ?? 0)
  const step = shown.length > 1 ? w / (shown.length - 1) : w
  const y = (v: number) => (h - 2 - (Math.min(top, Math.max(0, v)) / top) * (h - 4)).toFixed(1)
  const line = shown.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${y(v)}`).join(' ')
  const grid = [0.5, 1]
    .map(share => `<line x1="0" x2="${w}" y1="${y(top * share)}" y2="${y(top * share)}" stroke="${C.track}" stroke-dasharray="3 4"/>`)
    .join('')
  const dots = shown.map((v, i) => `<circle cx="${(i * step).toFixed(1)}" cy="${y(v)}" r="2" fill="${color}"/>`).join('')

  return svg(
    w,
    h,
    `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${color}" stop-opacity="0.45"/><stop offset="1" stop-color="${color}" stop-opacity="0.02"/>` +
      `</linearGradient></defs>${grid}` +
      `<path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#fill)"/>` +
      `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      (shown.length <= 30 ? dots : ''),
  )
}

/** A flat meter; `marker` draws a tick at a share of the width. */
export const meter = (share: number, color: string, w: number, marker?: number): string => {
  const tick =
    marker === undefined
      ? ''
      : `<rect x="${Math.min(w - 2, Math.max(0, marker * w - 1)).toFixed(1)}" y="0" width="2" height="10" rx="1" fill="${C.grey}"/>`

  return svg(
    w,
    10,
    `<rect y="1" width="${w}" height="8" rx="4" fill="${C.track}"/>` +
      `<rect y="1" width="${(Math.min(1, Math.max(0, share)) * w).toFixed(1)}" height="8" rx="4" fill="${color}"/>${tick}`,
  )
}

/** Columns, one a value; an empty value leaves its slot to the track alone. */
export const columns = (values: readonly number[], w: number, h: number, color: string): string => {
  const shown = values.slice(-60)
  const top = Math.max(...shown, 1e-9)
  // A few turns keep slim bars from the left rather than stretching into blocks.
  const slot = Math.min(16, w / Math.max(1, shown.length))
  const bars = shown
    .map((v, i) => {
      const x = (i * slot + slot * 0.15).toFixed(1)
      const width = (slot * 0.7).toFixed(1)
      if (v <= 0) return `<rect x="${x}" y="${h - 2}" width="${width}" height="2" rx="1" fill="${C.track}"/>`
      const bar = Math.max(3, (v / top) * (h - 2))

      return `<rect x="${x}" y="${(h - bar).toFixed(1)}" width="${width}" height="${bar.toFixed(1)}" rx="2" fill="${color}"/>`
    })
    .join('')

  return svg(w, h, bars)
}

/** One bar in parts side by side: the session's time split. */
export const stackedBar = (parts: readonly { share: number; color: string }[], w: number): string => {
  let x = 0
  const rects = parts
    .map(part => {
      const width = Math.max(0, part.share * w)
      const rect = `<rect x="${x.toFixed(1)}" y="1" width="${width.toFixed(1)}" height="8" fill="${part.color}"/>`
      x += width

      return rect
    })
    .join('')

  return svg(w, 10, `<clipPath id="r"><rect y="1" width="${w}" height="8" rx="4"/></clipPath><g clip-path="url(#r)">${rects}</g>`)
}

export const drawDesktop = (kit: Kit, p: Snapshot, now: number, act: (action: Action) => void): RenderElement => {
  const { Box, Text, Button, Svg } = kit
  // Cells inside a card: the pane's body less the card's border and padding.
  const inner = Math.max(20, p.columns - 4)
  const px = (cells: number) => Math.max(40, Math.floor(cells * PX))
  const chartWidth = px(inner - 1)
  const shown = PANELS.map(panel => panel.id).filter(id => !p.prefs.hidden.includes(id))

  /** A fixed-width cell, so rows and their header line up whatever the font. */
  const cell = (width: number, child: RenderElement, align: 'left' | 'right' = 'right') => (
    <Box width={width} flexShrink={0} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
      {child}
    </Box>
  )

  /** The stretchy cell of a row: it takes what the fixed cells leave, so a row spans the card. */
  const grow = (child: RenderElement) => (
    <Box flexGrow={1} flexShrink={1} minWidth={4}>
      {child}
    </Box>
  )

  /** A label on the left, its value on the right, one line that never wraps. */
  const pair = (label: string, value: RenderElement) => (
    <Box flexDirection="row" columnGap={1}>
      {cell(9, <Text dimColor>{label}</Text>, 'left')}
      {grow(value)}
    </Box>
  )

  const card = (id: PanelId, summary: RenderElement, body: () => RenderElement[]) => {
    const isFolded = p.prefs.collapsed.includes(id)

    return (
      <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button
            key={`fold-${id}`}
            plain
            label={`${isFolded ? '▸' : '▾'} ${LABELS[id]}`}
            onPress={() => act({ kind: 'collapse', panel: id })}
          />
          {summary}
        </Box>
        {isFolded ? null : body()}
      </Box>
    )
  }

  const clockAt = (time: number) => {
    const date = new Date(time)
    const at = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

    return time - now < 20 * 3_600_000 ? at : `${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][date.getDay()] ?? ''} ${at}`
  }

  // The fill now as a bar, how fast it grows, and the turn-by-turn chart once there are turns to compare.
  const context = () => {
    const percent = p.usage?.percent
    const history = p.history
    const recent = history.slice(-6)
    const growth = recent.length >= 2 ? ((recent[recent.length - 1] ?? 0) - (recent[0] ?? 0)) / (recent.length - 1) : undefined
    const top = scaleTop(history)

    return card(
      'context',
      percent === undefined ? <Text dimColor>waiting</Text> : <Text bold color={heat(percent)}>{`${Math.round(percent)}%`}</Text>,
      () =>
        percent === undefined || p.usage === null
          ? [<Text dimColor>waiting for the first response</Text>]
          : [
              <Box flexDirection="row" columnGap={1} alignItems="center">
                {cell(9, <Text dimColor>used</Text>, 'left')}
                {grow(<Svg source={meter(percent / 100, heat(percent), px(inner - 17))} alt={`Context ${Math.round(percent)}% full`} />)}
                {cell(6, <Text bold color={heat(percent)}>{`${Math.round(percent)}%`}</Text>)}
              </Box>,
              pair('tokens', <Text wrap="truncate-end">{`${compact(p.usage.tokens ?? 0)} of ${compact(p.usage.window)}`}</Text>),
              ...(growth === undefined
                ? []
                : [
                    pair(
                      'per turn',
                      <Text wrap="truncate-end">
                        {growth > 0.05
                          ? `+${growth.toFixed(1)}% · full in ~${Math.ceil((100 - percent) / growth)} turns`
                          : growth < -0.05
                            ? `${growth.toFixed(1)}% (compacted)`
                            : 'flat'}
                      </Text>,
                    ),
                  ]),
              ...(history.length >= 3
                ? [
                    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
                      <Text dimColor>{`last ${Math.min(history.length, 120)} turns`}</Text>
                      <Text dimColor>{`scale 0-${top}%`}</Text>
                    </Box>,
                    <Svg source={areaChart(history, chartWidth, 56, top)} alt={`Context over the last ${history.length} turns, from 0 to ${top}%`} />,
                  ]
                : [<Text dimColor>the chart appears after 3 turns</Text>]),
            ],
    )
  }

  // Each window as two bars, so the comparison reads at a glance: how much is used, how much of its time has passed.
  const limits = () => {
    const rows = p.usage?.rateLimits ?? []
    // Label 6 + value 6 + two gaps take 14 cells; the bar gets the rest.
    const barWidth = px(inner - 14)

    return card(
      'limits',
      <Text dimColor>{rows.map(row => `${limitLabel(row.kind)} ${Math.round(row.percentUsed)}%`).join('  ') || 'no reading'}</Text>,
      () =>
        rows.length === 0
          ? [<Text dimColor>no reading yet</Text>]
          : rows.map(row => {
              const elapsed = elapsedShare(row.kind, row.resetsAt, now)
              const ahead = pace(row.kind, row.percentUsed, row.resetsAt, now)

              return (
                <Box key={`limit-${row.kind}`} flexDirection="column" marginTop={1}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text bold>{limitLabel(row.kind)}</Text>
                    <Text dimColor>{`resets in ${resetsIn(row.resetsAt, now)}`}</Text>
                  </Box>
                  <Box flexDirection="row" columnGap={1} alignItems="center">
                    {cell(6, <Text dimColor>used</Text>, 'left')}
                    {grow(<Svg source={meter(row.percentUsed / 100, heat(row.percentUsed), barWidth)} alt={`${Math.round(row.percentUsed)}% of the window used`} />)}
                    {cell(6, <Text bold color={heat(row.percentUsed)}>{`${Math.round(row.percentUsed)}%`}</Text>)}
                  </Box>
                  {elapsed === undefined ? null : (
                    <Box flexDirection="row" columnGap={1} alignItems="center">
                      {cell(6, <Text dimColor>time</Text>, 'left')}
                      {grow(<Svg source={meter(elapsed, C.grey, barWidth)} alt={`${Math.round(elapsed * 100)}% of the window's time passed`} />)}
                      {cell(6, <Text dimColor>{`${Math.round(elapsed * 100)}%`}</Text>)}
                    </Box>
                  )}
                  {ahead === undefined ? null : (
                    <Text color={ahead > 10 ? C.high : ahead > 0 ? C.mid : C.low}>
                      {Math.abs(ahead) < 1
                        ? 'spending evenly'
                        : ahead > 0
                          ? `spending ${Math.round(ahead)} pts faster than even: runs out before the reset`
                          : `spending ${Math.round(-ahead)} pts slower than even`}
                    </Text>
                  )}
                </Box>
              )
            }),
    )
  }

  const cost = () => {
    const usd = p.usage?.costUsd
    const rate = perHour(usd, p.startedAt, now)
    const hit = cacheHit(p.tokens)
    const spent = deltas(p.costs)
    const last = spent[spent.length - 1]
    const average = spent.length === 0 ? undefined : spent.reduce((sum, v) => sum + v, 0) / spent.length
    const dollars = (v: number | undefined) => (v === undefined ? '-' : `$${v.toFixed(2)}`)

    return card(
      'cost',
      <Text bold color={C.accent}>{dollars(usd)}</Text>,
      () => [
        pair('total', <Text bold color={C.accent} wrap="truncate-end">{`${dollars(usd)}  ·  ${p.tokens.turns} ${p.tokens.turns === 1 ? 'turn' : 'turns'}`}</Text>),
        pair('per hour', <Text wrap="truncate-end">{dollars(rate)}</Text>),
        ...(spent.length > 0
          ? [
              pair('per turn', <Text wrap="truncate-end">{`last ${dollars(last)} · avg ${dollars(average)} · max ${dollars(Math.max(...spent))}`}</Text>),
              <Svg source={columns(spent, px(inner - 1), 24, C.violet)} alt="Cost of each turn, oldest on the left" />,
            ]
          : []),
        pair('tokens', <Text wrap="truncate-end">{`in ${compact(p.tokens.input + p.tokens.cacheRead + p.tokens.cacheWrite)} · out ${compact(p.tokens.output)}`}</Text>),
        ...(hit === undefined
          ? []
          : [
              <Box flexDirection="row" columnGap={1} alignItems="center">
                {cell(9, <Text dimColor>cache</Text>, 'left')}
                {grow(<Svg source={meter(hit, hit >= 0.8 ? C.low : hit >= 0.5 ? C.mid : C.high, px(inner - 17))} alt={`${Math.round(hit * 100)}% of input reread from the cache`} />)}
                {cell(6, <Text bold>{`${Math.round(hit * 100)}%`}</Text>)}
              </Box>,
              <Text dimColor wrap="truncate-end">reread input, billed at ~1/10</Text>,
            ]),
      ],
    )
  }

  // Fixed columns after the name: calls 7, err 5, avg 8, total 8, max 8, and a gap before each.
  const TOOL_COLUMNS = 7 + 5 + 8 + 8 + 8 + 5

  const tools = () => {
    const rows = sortedTools(p.tools, p.prefs.sort, p.prefs.reverse)
    const calls = rows.reduce((sum, row) => sum + row.calls, 0)
    const errors = rows.reduce((sum, row) => sum + row.errors + row.denied, 0)
    const isTable = inner - TOOL_COLUMNS >= 10
    const sortButton = (key: (typeof p.prefs)['sort'], label: string) => (
      <Button
        key={`sort-${key}`}
        plain
        dimColor={p.prefs.sort !== key}
        label={`${label}${p.prefs.sort === key ? (p.prefs.reverse ? '▲' : '▼') : ''}`}
        onPress={() => act({ kind: 'sort', key })}
      />
    )
    const failed = (row: (typeof rows)[number]) => row.errors + row.denied

    const table = () => [
      <Box flexDirection="row" columnGap={1}>
        {grow(sortButton('name', 'tool'))}
        {cell(7, sortButton('calls', 'calls'))}
        {cell(5, sortButton('errors', 'err'))}
        {cell(8, sortButton('avg', 'avg'))}
        {cell(8, sortButton('time', 'total'))}
        {cell(8, sortButton('max', 'max'))}
      </Box>,
      ...rows.slice(0, 12).map(row => (
        <Box key={`tool-${row.name}`} flexDirection="row" columnGap={1}>
          {grow(<Text color={C.blue} wrap="truncate-end">{row.name}</Text>)}
          {cell(7, <Text>{String(row.calls)}</Text>)}
          {cell(5, failed(row) > 0 ? <Text color={C.high}>{String(failed(row))}</Text> : <Text dimColor>0</Text>)}
          {cell(8, <Text dimColor>{duration(row.totalMs / Math.max(1, row.calls))}</Text>)}
          {cell(8, <Text>{duration(row.totalMs)}</Text>)}
          {cell(8, <Text dimColor>{duration(row.maxMs)}</Text>)}
        </Box>
      )),
    ]

    // Too narrow for six columns: the sort keys wrap on a row of their own, a tool takes two rows.
    const stacked = () => [
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text dimColor>sort</Text>
        {sortButton('name', 'tool')}
        {sortButton('calls', 'calls')}
        {sortButton('errors', 'err')}
        {sortButton('avg', 'avg')}
        {sortButton('time', 'total')}
        {sortButton('max', 'max')}
      </Box>,
      ...rows.slice(0, 12).map(row => (
        <Box key={`tool-${row.name}`} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" columnGap={1}>
            {grow(<Text color={C.blue} wrap="truncate-end">{row.name}</Text>)}
            <Text bold>{`${row.calls}×`}</Text>
            {failed(row) > 0 ? <Text color={C.high}>{`${failed(row)} err`}</Text> : null}
          </Box>
          <Text dimColor>
            {`avg ${duration(row.totalMs / Math.max(1, row.calls))} · total ${duration(row.totalMs)} · max ${duration(row.maxMs)}`}
          </Text>
        </Box>
      )),
    ]

    return card(
      'tools',
      <Text dimColor>{`${calls} calls${errors > 0 ? ` · ${errors} errors` : ''}`}</Text>,
      () => (rows.length === 0 ? [<Text dimColor>no tool calls yet</Text>] : isTable ? table() : stacked()),
    )
  }

  // Two rows a subagent: its type, model and time on top, what it was asked below, so nothing runs past the card.
  const agents = () => {
    const running = p.agents.filter(agent => agent.status === 'running').length
    const list = [...p.agents]
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
      .slice(0, 8)
    const color = { running: C.mid, completed: C.low, failed: C.high, killed: C.grey }

    return card(
      'agents',
      <Text dimColor>{`${running} running · ${p.agents.length - running} done`}</Text>,
      () =>
        list.length === 0
          ? [<Text dimColor>no subagents yet</Text>]
          : list.map(agent => (
              <Box key={`agent-${agent.id}`} flexDirection="column" marginTop={1}>
                <Box flexDirection="row" columnGap={1}>
                  {cell(2, <Text color={color[agent.status]}>●</Text>, 'left')}
                  {grow(<Text bold wrap="truncate-end">{agent.type}</Text>)}
                  <Text dimColor>{shortModel(agent.model)}</Text>
                  {cell(7, <Text dimColor>{duration(agent.status === 'running' ? now - agent.startedAt : (agent.durationMs ?? 0))}</Text>)}
                </Box>
                <Box flexDirection="row" columnGap={1}>
                  {cell(2, <Text> </Text>, 'left')}
                  {grow(<Text dimColor wrap="truncate-end">{agent.description}</Text>)}
                </Box>
              </Box>
            )),
    )
  }

  // A window per block of short label-value lines: nothing wraps, and the verdict sits on its own line.
  const forecast = () => {
    const rows = forecastLimits(p.usage, p.samples, now)
    const worst = rows.find(row => row.isShort)
    const usesAverage = rows.some(row => row.rate > 0 && row.basis === 'window')

    return card(
      'forecast',
      worst === undefined ? <Text color={C.low}>lasts</Text> : <Text color={C.high}>{`${limitLabel(worst.kind)} runs out`}</Text>,
      () =>
        rows.length === 0
          ? [<Text dimColor>no rate-limit reading yet</Text>]
          : [
              ...rows.map(row => (
                <Box key={`forecast-${row.kind}`} flexDirection="column" marginTop={1}>
                  <Box flexDirection="row" columnGap={1}>
                    <Text bold>{limitLabel(row.kind)}</Text>
                    <Text bold color={heat(row.percent)}>{`${Math.round(row.percent)}% used`}</Text>
                  </Box>
                  {pair('speed', <Text wrap="truncate-end">{row.rate > 0 ? `${row.basis === 'window' ? '~' : ''}${row.rate.toFixed(1)}% / hour` : 'not climbing'}</Text>)}
                  {row.fullAt === undefined ? null : pair('full at', <Text bold={row.isShort} wrap="truncate-end">{clockAt(row.fullAt)}</Text>)}
                  {row.resetAt === undefined ? null : pair('reset', <Text wrap="truncate-end">{clockAt(row.resetAt)}</Text>)}
                  {row.fullAt === undefined ? null : row.isShort && row.resetAt !== undefined ? (
                    <Text color={C.high} wrap="truncate-end">{`✕ runs out ${duration(row.resetAt - row.fullAt)} early`}</Text>
                  ) : (
                    <Text color={C.low} wrap="truncate-end">✓ lasts until the reset</Text>
                  )}
                </Box>
              )),
              ...(usesAverage ? [<Text dimColor wrap="truncate-end">~ average since the window opened</Text>] : []),
            ],
    )
  }

  const time = () => {
    const split = timeSplit(p.timing, p.startedAt, now)
    const share = (ms: number) => (split.total > 0 ? ms / split.total : 0)
    const parts = [
      { label: 'model', ms: split.model, color: C.violet },
      { label: 'tools', ms: split.tools, color: C.blue },
      { label: 'you', ms: split.idle, color: C.grey },
    ]

    return card(
      'time',
      <Text dimColor>{split.total > 0 ? `model ${Math.round(share(split.model) * 100)}%` : 'no turns'}</Text>,
      () =>
        split.total <= 0
          ? [<Text dimColor>no finished turn yet</Text>]
          : [
              <Svg source={stackedBar(parts.map(part => ({ share: share(part.ms), color: part.color })), chartWidth)} alt="Where the session's time went" />,
              <Box flexDirection="row" columnGap={2} flexWrap="wrap">
                {parts.map(part => (
                  <Box key={`time-${part.label}`} flexDirection="row" columnGap={1}>
                    <Text color={part.color}>■</Text>
                    <Text dimColor>{part.label}</Text>
                    <Text bold>{`${Math.round(share(part.ms) * 100)}%`}</Text>
                    <Text dimColor>{duration(part.ms)}</Text>
                  </Box>
                ))}
              </Box>,
            ],
    )
  }

  const files = () => {
    const rows = hotFiles(p.files)

    return card(
      'files',
      <Text dimColor>{`${rows.length} ${rows.length === 1 ? 'file' : 'files'}`}</Text>,
      () =>
        rows.length === 0
          ? [<Text dimColor>no file read or changed yet</Text>]
          : [
              <Box flexDirection="row" columnGap={1}>
                {cell(5, <Text dimColor>read</Text>)}
                {cell(5, <Text dimColor>edit</Text>)}
                {grow(<Text dimColor>path</Text>)}
              </Box>,
              ...rows.slice(0, 10).map(row => (
                <Box key={`file-${row.path}`} flexDirection="row" columnGap={1}>
                  {cell(5, <Text color={C.blue}>{row.reads === 0 ? '·' : String(row.reads)}</Text>)}
                  {cell(5, <Text color={C.accent} bold={row.edits > 0}>{row.edits === 0 ? '·' : String(row.edits)}</Text>)}
                  {grow(<Text wrap="truncate-start">{shortPath(row.path, p.cwd)}</Text>)}
                </Box>
              )),
            ],
    )
  }

  const bash = () => {
    const rows = busyCommands(p.commands)

    return card(
      'bash',
      <Text dimColor>{`${rows.reduce((sum, row) => sum + row.calls, 0)} runs`}</Text>,
      () =>
        rows.length === 0
          ? [<Text dimColor>no shell command yet</Text>]
          : [
              <Box flexDirection="row" columnGap={1}>
                {grow(<Text dimColor>command</Text>)}
                {cell(6, <Text dimColor>runs</Text>)}
                {cell(5, <Text dimColor>err</Text>)}
                {cell(8, <Text dimColor>time</Text>)}
              </Box>,
              ...rows.slice(0, 10).map(row => (
                <Box key={`cmd-${row.name}`} flexDirection="row" columnGap={1}>
                  {grow(<Text color={C.blue} wrap="truncate-end">{row.name}</Text>)}
                  {cell(6, <Text>{String(row.calls)}</Text>)}
                  {cell(5, row.errors > 0 ? <Text color={C.high}>{String(row.errors)}</Text> : <Text dimColor>0</Text>)}
                  {cell(8, <Text dimColor>{duration(row.totalMs)}</Text>)}
                </Box>
              )),
            ],
    )
  }

  const week = () => {
    const list = recentDays(p.days, now, 7)
    const total = list.reduce((sum, { day }) => sum + day.usd, 0)
    const top = Math.max(1e-9, ...list.map(({ day }) => day.usd))
    const today = dayKey(now)
    // Day 7 + $ 9 + tokens 7 + three gaps take 26 cells; the bar gets the rest.
    const barWidth = px(inner - 26)

    return card('week', <Text bold color={C.accent}>{`7d $${total.toFixed(2)}`}</Text>, () =>
      list.map(({ key, day }) => {
        const isToday = key === today

        return (
          <Box key={`day-${key}`} flexDirection="row" columnGap={1} alignItems="center">
            {cell(
              7,
              <Text bold={isToday} dimColor={!isToday}>
                {`${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][new Date(`${key}T12:00:00`).getDay()] ?? ''} ${key.slice(8)}`}
              </Text>,
              'left',
            )}
            {grow(<Svg source={meter(day.usd / top, isToday ? C.accent : C.violet, barWidth)} alt={`${key}: $${day.usd.toFixed(2)}`} />)}
            {cell(9, <Text bold={isToday}>{day.usd > 0 ? `$${day.usd.toFixed(2)}` : '-'}</Text>)}
            {cell(7, <Text dimColor>{day.tokensIn + day.tokensOut > 0 ? compact(day.tokensIn + day.tokensOut) : ''}</Text>)}
          </Box>
        )
      }),
    )
  }

  const draw: Record<PanelId, () => RenderElement> = { context, limits, cost, tools, agents, forecast, time, files, bash, week }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={C.accent}>cctop</Text>
        <Text dimColor>{[shortModel(p.model), p.startedAt > 0 ? `up ${duration(Math.max(0, now - p.startedAt))}` : ''].filter(Boolean).join(' · ')}</Text>
      </Box>
      <Box flexDirection="row" columnGap={3} flexWrap="wrap" marginTop={1}>
        {[true, false].map(isDefault => (
          <Box key={`group-${isDefault ? 'default' : 'optional'}`} flexDirection="column">
            <Text dimColor>{isDefault ? 'default' : 'optional'}</Text>
            {PANELS.filter(panel => panel.isDefault === isDefault).map(panel => {
              const isOn = !p.prefs.hidden.includes(panel.id)

              return (
                <Box key={`row-${panel.id}`} flexDirection="row" columnGap={1}>
                  {cell(
                    12,
                    <Button
                      key={`show-${panel.id}`}
                      plain
                      dimColor={!isOn}
                      label={`${isOn ? '●' : '○'} ${LABELS[panel.id]}`}
                      onPress={() => act({ kind: 'visible', panel: panel.id, on: !isOn })}
                    />,
                    'left',
                  )}
                  <Text dimColor>{panel.about}</Text>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1}>
        <Button key="reset" plain dimColor label="reset layout" onPress={() => act({ kind: 'reset' })} />
        <Text dimColor>context alert</Text>
        <Button key="alert" plain label={`speaks as ${p.prefs.alert}`} onPress={() => act({ kind: 'alert' })} />
        <Button key="threshold" plain label={`past ${p.prefs.threshold}%`} onPress={() => act({ kind: 'threshold' })} />
      </Box>
      {shown.length === 0 ? <Text dimColor>every panel is hidden: pick one above</Text> : shown.map(id => draw[id]())}
    </Box>
  )
}
