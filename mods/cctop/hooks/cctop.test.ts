import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { scaleTop } from './desktop'
import { bar, brailleGraph, cacheHit, compact, duration, resetsIn, spark, toolLabel } from './format'
import {
  applyAction,
  commandKey,
  deltas,
  parseDayBook,
  sumDays,
  touchDay,
  DEFAULT_PREFS,
  forecastLimits,
  pace,
  parseAction,
  parsePrefs,
  recentDays,
  shortModel,
  shortPath,
  sortedTools,
  timeSplit,
} from './model'

const NOW = Date.parse('2026-10-07T12:00:00Z')

const PANE = {
  plugin: 'cctop',
  component: 'Pane',
  requestId: 'cctop',
  props: {
    title: 'cctop',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

describe('format', () => {
  test('numbers and times read short', async () => {
    expect(compact(950)).toBe('950')
    expect(compact(12_345)).toBe('12k')
    expect(compact(1_234)).toBe('1.2k')
    expect(compact(2_500_000)).toBe('2.5M')
    expect(duration(340)).toBe('340ms')
    expect(duration(1500)).toBe('1.5s')
    expect(duration(125_000)).toBe('2m05s')
    expect(resetsIn('2026-10-07T14:15:00Z', NOW)).toBe('2h15m')
    expect(resetsIn('2026-10-09T13:00:00Z', NOW)).toBe('2d1h')
    expect(resetsIn(undefined, NOW)).toBe('')
  })

  test('bars, sparks, tool names and cache share', async () => {
    expect(bar(0.5, 10)).toEqual(['█████', '░░░░░'])
    expect(spark([0, 50, 100], 10)).toBe('▁▅█')
    expect(toolLabel('mcp__graphify__query_graph')).toBe('graphify:query_graph')
    expect(cacheHit({ input: 10, output: 5, cacheRead: 80, cacheWrite: 10, turns: 1 })).toBe(0.8)
    expect(cacheHit({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })).toBe(undefined)
  })

  test('the braille graph fills from the floor, newest on the right', async () => {
    // One row, two cells: the left cell is padding, the right holds 0 and 100.
    expect(brailleGraph([0, 100], 2, 1)).toEqual(['⠀⢸'])
    // A full column over two rows lights all eight dots of the cell in each row.
    expect(brailleGraph([100, 100], 1, 2)).toEqual(['⣿', '⣿'])
    // Half height over two rows: the bottom row full, the top row empty.
    expect(brailleGraph([50, 50], 1, 2)).toEqual(['⠀', '⣿'])
  })
})

describe('model', () => {
  test('layout actions fold, hide, sort and reset', async () => {
    const folded = applyAction(DEFAULT_PREFS, { kind: 'collapse', panel: 'cost' })
    expect(folded.collapsed).toEqual(['cost'])
    expect(applyAction(folded, { kind: 'collapse', panel: 'cost' }).collapsed).toEqual([])
    expect(applyAction(DEFAULT_PREFS, { kind: 'visible', panel: 'tools', on: false }).hidden).toContain('tools')
    expect(applyAction(DEFAULT_PREFS, { kind: 'visible', panel: 'files', on: true }).hidden).not.toContain('files')
    const sorted = applyAction(DEFAULT_PREFS, { kind: 'sort', key: 'calls' })
    expect(sorted).toMatchObject({ sort: 'calls', reverse: false })
    expect(applyAction(sorted, { kind: 'sort', key: 'calls' }).reverse).toBe(true)
    expect(applyAction(folded, { kind: 'reset' })).toEqual(DEFAULT_PREFS)
    // Reset brings the default panels back but keeps how the alert speaks.
    const quiet = applyAction(applyAction(DEFAULT_PREFS, { kind: 'alert' }), { kind: 'visible', panel: 'files', on: true })
    expect(applyAction(quiet, { kind: 'reset' })).toEqual({ ...DEFAULT_PREFS, alert: 'status' })
    expect(DEFAULT_PREFS.hidden).toEqual(['cost', 'forecast', 'time', 'files', 'bash'])
  })

  test('posted data and stored layouts are checked', async () => {
    expect(parseAction({ kind: 'collapse', panel: 'nope' })).toBe(undefined)
    expect(parseAction({ kind: 'visible', panel: 'agents', on: true })).toEqual({ kind: 'visible', panel: 'agents', on: true })
    expect(parseAction('reset')).toBe(undefined)
    expect(parsePrefs({ layout: 2, hidden: ['tools', 'x'], sort: 'bogus' })).toEqual({ ...DEFAULT_PREFS, hidden: ['tools'] })
    // A layout stored before the default set changed starts from the new defaults, keeping the alert.
    expect(parsePrefs({ hidden: [], alert: 'off', threshold: 90 })).toEqual({ ...DEFAULT_PREFS, alert: 'off', threshold: 90 })
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS)
  })

  test('tools sort by the chosen column, names from A', async () => {
    const stats = {
      Bash: { calls: 3, errors: 1, denied: 0, totalMs: 900, maxMs: 500 },
      Read: { calls: 9, errors: 0, denied: 0, totalMs: 300, maxMs: 80 },
    }
    expect(sortedTools(stats, 'time', false).map(row => row.name)).toEqual(['Bash', 'Read'])
    expect(sortedTools(stats, 'calls', false).map(row => row.name)).toEqual(['Read', 'Bash'])
    expect(sortedTools(stats, 'name', true).map(row => row.name)).toEqual(['Read', 'Bash'])
  })

  test('pace compares the used share with the elapsed share', async () => {
    // Five hour window, 2h30m left: half elapsed, so 70% used is 20 points ahead.
    expect(Math.round(pace('five_hour', 70, '2026-10-07T14:30:00Z', NOW) ?? 0)).toBe(20)
    expect(pace('other', 70, '2026-10-07T14:30:00Z', NOW)).toBe(undefined)
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
  })
})

describe('analytics', () => {
  test('shell commands group by program and subcommand', async () => {
    expect(commandKey('git status --short')).toBe('git status')
    expect(commandKey('cd /tmp && make -j4')).toBe('make')
    expect(commandKey('sudo docker compose up -d')).toBe('docker compose')
    expect(commandKey('FOO=1 npm run build | tail')).toBe('npm run')
    expect(commandKey('/usr/bin/ls -la')).toBe('ls')
  })

  test('a limit forecast warns when the window fills before it resets', async () => {
    const usage = { window: 1, rateLimits: [{ kind: 'five_hour', percentUsed: 60, resetsAt: '2026-10-07T14:00:00Z' }] }
    // 40 points in the last 40 minutes: 60 points an hour, so 100% lands 40 minutes from now.
    const samples = { five_hour: [{ at: NOW - 40 * 60_000, percent: 20 }, { at: NOW, percent: 60 }] }
    const [row] = forecastLimits(usage, samples, NOW)
    expect(row).toMatchObject({ basis: 'recent', isShort: true })
    expect(Math.round(row?.rate ?? 0)).toBe(60)
    expect(row?.fullAt).toBe(NOW + 40 * 60_000)
    // With no recent movement the window's own average decides: 60% over 3 of 5 hours lasts.
    const [calm] = forecastLimits(usage, {}, NOW)
    expect(calm).toMatchObject({ basis: 'window', isShort: false })
  })

  test('the context chart scales to its values, not always to 100%', async () => {
    expect(scaleTop([5, 7, 8])).toBe(10)
    expect(scaleTop([30])).toBe(50)
    expect(scaleTop([95])).toBe(100)
  })

  test('session time splits into model, tools and waiting', async () => {
    const split = timeSplit({ turnMs: 600_000, toolMs: 200_000, turns: 3 }, NOW - 1_000_000, NOW)
    expect(split).toEqual({ model: 400_000, tools: 200_000, idle: 400_000, total: 1_000_000 })
  })

  test('days add up across sessions and the week fills its gaps', async () => {
    // A session started today counts from 0, so cost spent before the mod loaded is in.
    const a = touchDay({}, '2026-10-07', 'term', { usd: 18.94, isStartDay: true, tokensIn: 10, tokensOut: 5, turns: 1 })
    // One running since yesterday counts from what it had cost when first seen today.
    const b = touchDay(a, '2026-10-07', 'desk', { usd: 3, isStartDay: false })
    const c = touchDay(b, '2026-10-07', 'desk', { usd: 4.5, isStartDay: false, tokensIn: 1, tokensOut: 1, turns: 1 })
    const two = sumDays(c)
    expect(two['2026-10-07']).toEqual({ usd: 20.44, tokensIn: 11, tokensOut: 6, turns: 2 })
    expect(parseDayBook(JSON.stringify(c))).toEqual(c)
    expect(parseDayBook('{"2026-10-07":{"x":{"usd":"bad"}},"nope":{}}')).toEqual({})
    expect(parseDayBook('not json')).toEqual({})
    // The first total is what came before the mod; turns start from the second.
    expect(deltas([5, 5.4, 5.5]).map(v => Math.round(v * 10) / 10)).toEqual([0.4, 0.1])
    const week = recentDays(two, NOW, 7)
    expect(week).toHaveLength(7)
    expect(week[6]?.key).toBe('2026-10-07')
    expect(week[0]?.day.turns).toBe(0)
    expect(shortPath('/home/me/work/app/a.php', '/home/me/work')).toBe('app/a.php')
    expect(shortPath('/home/me/notes.md', '/srv')).toBe('~/notes.md')
  })
})

const SURFACES = ['terminal', 'desktop'] as const

test('an empty session draws placeholders on every surface', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const scope = surface === 'terminal' ? { in: 'top' } : {}
    expect(await ui.find({ type: 'Text', text: 'waiting for the first response', ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no tool calls yet', ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no subagents yet', ...scope })).toBeDefined()
  }
})

test('measure, a timed tool call and a turn reach both drawings', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 3_600_000,
      context: { tokens: 96_000, window: 200_000, percent: 48 },
      rateLimits: [],
      cost: { usd: 1.234 },
    },
  }))
  on('tool.call', async () => {
    await clock.advance(1500)

    return { result: 'pong' }
  })

  await $.session.measure({
    context: { tokens: 96_000, window: 200_000, percent: 48 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-07T14:15:00Z' }],
    cost: { usd: 1.234 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'call-1' })
  await $.turn.complete({
    answer: 'done',
    durationMs: 3000,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    },
  })

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const inTop = { in: 'top' }
  // cost is optional: key 6 shows it.
  await terminal.key({ key: '6', in: 'top' })
  expect(await terminal.find({ type: 'Text', text: '48%', ...inTop })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '96k/200k', ...inTop })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '23%', ...inTop })).toBeDefined()
  // The tool call moved the clock 1.5 s, so 2h14m58s are left.
  expect(await terminal.find({ type: 'Text', text: '↻2h14m', ...inTop })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '$1.23', ...inTop })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '80%', ...inTop })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'demo:ping', ...inTop })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'opus 5.5', ...inTop })).toBeDefined()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: '48%' })).toBeDefined()
  // Shown from the terminal a moment ago: the layout is one for every surface.
  expect(await desktop.find({ key: 'card-cost' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '$1.23' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: 'demo:ping' })).toBeDefined()
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
})

/** A store in memory the test can read back, standing where the engine's would. */
const memoryStore = (on: On) => {
  const entries = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: entries.get(e.key) }))
  on('store.set', ($, e) => {
    entries.set(e.key, e.value)

    return { value: undefined }
  })

  return entries
}

test('the terminal folds a panel on a click and hides one on its digit', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = memoryStore(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Row 0 is the top bar; row 1 opens the context box: `╭─¹context ▾`.
  await ui.pointer({ type: 'down', x: 5, y: 1, button: 'left', in: 'top' })
  expect(await ui.find({ type: 'Text', text: ' ▸', in: 'top' })).toBeDefined()
  expect(saved.get('prefs')).toMatchObject({ collapsed: ['context'] })

  // Tools is panel 3 now.
  await ui.key({ key: '3', in: 'top' })
  expect(await ui.find({ type: 'Text', text: 'no tool calls yet', in: 'top' })).toBe(undefined)
  expect((saved.get('prefs') as { hidden: string[] }).hidden).toContain('tools')
})

test('the desktop folds and hides panels with its buttons', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = memoryStore(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'fold-context' })
  expect((await ui.find({ key: 'fold-context' }))?.text).toContain('▸')

  await ui.press({ key: 'show-tools' })
  expect(await ui.find({ key: 'card-tools' })).toBe(undefined)
  expect(saved.get('prefs')).toMatchObject({ collapsed: ['context'] })
  expect((saved.get('prefs') as { hidden: string[] }).hidden).toContain('tools')

  await ui.press({ key: 'reset' })
  expect(await ui.find({ key: 'card-tools' })).toBeDefined()
})

test('files and shell commands are counted from tool calls', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('tool.call', ($, e) => (e.tool === 'Bash' ? { isError: true, result: 'boom', text: 'boom' } : { result: 'ok' }))

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/w/a.ts' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/w/a.ts' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/w/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git status' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // files (9) and bash (0) are optional panels.
  await ui.key({ key: '9', in: 'top' })
  await ui.key({ key: '0', in: 'top' })
  expect(await ui.find({ type: 'Text', text: 'git status', in: 'top' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/w/a.ts', in: 'top' })).toBeDefined()
})

test('the context alert toasts once past the threshold', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text))

    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const measure = (percent: number) =>
    $.session.measure({ context: { tokens: percent * 1000, window: 100_000, percent }, rateLimits: [], changed: ['context'] })

  await measure(65)
  await measure(72)
  await measure(75)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('72%')
  // Below the threshold by 5 points it rearms.
  await measure(60)
  await measure(71)
  expect(toasts).toHaveLength(2)
})

test('the menu cycles the alert mode and threshold', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = memoryStore(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'alert' })
  await ui.press({ key: 'threshold' })
  expect(saved.get('prefs')).toMatchObject({ alert: 'status', threshold: 80 })
})

test('the desktop draws every chart as a plain image, never in a white sandboxed frame', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = memoryStore(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 50_000, window: 100_000, percent: 50 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 48, resetsAt: '2026-10-07T13:47:00Z' }],
    cost: { usd: 1 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const panel of ['cost', 'forecast', 'time', 'files', 'bash']) await ui.press({ key: `show-${panel}` })
  const charts = await ui.findAll({ type: 'Svg' })
  expect(charts.length).toBeGreaterThan(0)
  for (const chart of charts) expect(chart.props.isInteractive).toBe(undefined)
  // Limits show the used share beside the share of the window's time that has passed.
  expect(await ui.find({ type: 'Text', text: 'time' })).toBeDefined()
  expect(saved.get('prefs')).toBeDefined()
})

test('the week sums every session through one shared file', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const files = new Map<string, string>()
  let session = 'terminal'
  on('env.get', ($, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: session }))
  on('fs.read', ($, e) => {
    const text = files.get((e as { path: string }).path)

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files.set(path, text)

    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const spend = (usd: number) =>
    $.session.measure({ context: { tokens: 1, window: 100, percent: 1 }, rateLimits: [], cost: { usd }, changed: ['cost'] })

  await spend(2.5)
  session = 'desktop'
  await spend(1.25)

  const book = JSON.parse(files.get('/home/me/.claude/cctop/days.json') ?? '{}') as Record<string, Record<string, { usd: number }>>
  expect(Object.keys(book['2026-10-07'] ?? {}).sort()).toEqual(['desktop', 'terminal'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '7d $3.75' })).toBeDefined()
})
