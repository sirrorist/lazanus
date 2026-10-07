import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { AgentRow, AgentState, CommandStat, FileStat, Prefs, Tokens, ToolStat, UsageSnap } from '../types'
import { drawDesktop } from './desktop'
import { toolLabel } from './format'
import type { Action, Snapshot } from './model'
import type { SessionChange } from './model'
import { applyAction, commandKey, dayKey, DEFAULT_PREFS, parseAction, parseDayBook, parsePrefs, sumDays, touchDay } from './model'

const PANE = 'cctop'
const HISTORY = 120
const MAX_AGENTS = 32
const PREFS_KEY = 'prefs'
const MAX_FILES = 200
const MAX_COMMANDS = 100
const MAX_SAMPLES = 60
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
const ZERO_TOOL: ToolStat = { calls: 0, errors: 0, denied: 0, totalMs: 0, maxMs: 0 }

const usage = atom({ plugin: 'cctop', key: 'usage' } as const, null)
const history = atom({ plugin: 'cctop', key: 'history' } as const, [])
const costs = atom({ plugin: 'cctop', key: 'costs' } as const, [])
const tokens = atom({ plugin: 'cctop', key: 'tokens' } as const, ZERO_TOKENS)
const tools = atom({ plugin: 'cctop', key: 'tools' } as const, {})
const agents = atom({ plugin: 'cctop', key: 'agents' } as const, [])
const prefs = atom({ plugin: 'cctop', key: 'prefs' } as const, DEFAULT_PREFS)
const model = atom({ plugin: 'cctop', key: 'model' } as const, '')
const startedAt = atom({ plugin: 'cctop', key: 'startedAt' } as const, 0)
const cwd = atom({ plugin: 'cctop', key: 'cwd' } as const, '')
const files = atom({ plugin: 'cctop', key: 'files' } as const, {})
const commands = atom({ plugin: 'cctop', key: 'commands' } as const, {})
const timing = atom({ plugin: 'cctop', key: 'timing' } as const, { turnMs: 0, toolMs: 0, turns: 0 })
const samples = atom({ plugin: 'cctop', key: 'samples' } as const, {})
const days = atom({ plugin: 'cctop', key: 'days' } as const, {})
const isAlerted = atom({ plugin: 'cctop', key: 'isAlerted' } as const, false)

const snapOf = (
  context: SessionContextUsage,
  rateLimits: readonly SessionRateLimit[],
  cost: SessionCost | undefined,
): UsageSnap => ({
  tokens: context.tokens,
  window: context.window,
  percent: context.percent,
  rateLimits: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
  costUsd: cost?.usd,
})

const agentState = (reason: string): AgentState =>
  reason === 'aborted' ? 'killed' : reason === 'answer' ? 'completed' : 'failed'

/** Copies the saved layout into the session: at the start, and again after /clear, /resume or /branch. */
const loadPrefs = async ($: EngineInterface) => {
  const saved = parsePrefs(await $.store.get(PREFS_KEY))
  await update($, prefs, () => saved)
}

/** Applies a layout change and saves it, building on what the store holds now (another session may have changed it). */
const change = async ($: EngineInterface, action: Action) => {
  const next: Prefs = applyAction(parsePrefs(await $.store.get(PREFS_KEY)), action)
  await $.store.set(PREFS_KEY, next)
  await update($, prefs, () => next)
  // A new mode or threshold is judged afresh at the next measurement.
  if (action.kind === 'alert' || action.kind === 'threshold' || action.kind === 'reset') {
    $.ui.status(undefined)
    await update($, isAlerted, () => false)
    await checkAlert($, (await read($, usage))?.percent)
  }
}

/**
 * The day book lives in a file, not in `$.store`: the desktop loads the mod as
 * `cctop@inline` and the terminal as `cctop@lazanus`, and each id gets a store
 * of its own. A file under the home directory is one for every session.
 */
const bookPath = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? ''}/.claude/cctop/days.json`

/** A missing or unreadable file is an empty book: the week starts over rather than the session failing. */
const readBook = async ($: EngineInterface) => {
  try {
    return parseDayBook(await $.fs.read(await bookPath($)))
  } catch {
    return parseDayBook(undefined)
  }
}

/** Updates this session's share of today: read the file, change, write it back at once. */
const recordDay = async ($: EngineInterface, delta: Omit<SessionChange, 'isStartDay'>) => {
  const now = await $.clock.now()
  const today = dayKey(now)
  const began = await read($, startedAt)
  const book = touchDay(await readBook($), today, await $.session.id(), {
    ...delta,
    // An unknown start counts the session's whole cost: better than counting none of it.
    isStartDay: began <= 0 || dayKey(began) === today,
  })
  await $.fs.write(await bookPath($), JSON.stringify(book))
  await update($, days, () => sumDays(book))
}

/**
 * Speaks once when the context fills past the threshold, in the chosen mode;
 * a status line entry follows the fill until it drops 5 points below.
 */
const checkAlert = async ($: EngineInterface, percent: number | undefined) => {
  if (percent === undefined) return
  const { alert, threshold } = await read($, prefs)
  const wasAlerted = await read($, isAlerted)
  const rounded = Math.round(percent)

  if (alert !== 'off' && percent >= threshold) {
    if (!wasAlerted && (alert === 'toast' || alert === 'both')) {
      $.ui.toast(`cctop: context ${rounded}%, past ${threshold}%`)
    }
    if (alert === 'status' || alert === 'both') $.ui.status(`ctx ${rounded}%`)
    if (!wasAlerted) await update($, isAlerted, () => true)
  } else if (wasAlerted && percent < threshold - 5) {
    $.ui.status(undefined)
    await update($, isAlerted, () => false)
  }
}

const startSession = async ($: EngineInterface) => {
  const now = await $.session.usage()
  await update($, usage, () => snapOf(now.context, now.rateLimits, now.cost))
  await update($, startedAt, () => now.startedAt)
  const current = await $.session.model()
  await update($, model, () => current ?? '')
  const folder = await $.session.cwd()
  await update($, cwd, () => folder)
  const book = await readBook($)
  await update($, days, () => sumDays(book))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cctop',
      description: 'Open cctop: context, limits, cost, tools and subagents',
      immediate: true,
    })
    await loadPrefs($)
    await startSession($)
    // No redraw timer: the terminal's Client ticks its own clock, and a per-second redraw
    // makes the desktop reload every SVG, which shows as a flicker. Data changes redraw by state.

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadPrefs($)
    await startSession($)

    return next(e)
  })

  on('command.run', { command: 'cctop' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'cctop' })

    return opened.isPlaced ? {} : { text: 'cctop: widen the terminal to see it.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => snapOf(e.context, e.rateLimits, e.cost))

    try {
      const at = await $.clock.now()
      await update($, samples, all => {
        const nextAll = { ...all }
        for (const limit of e.rateLimits) {
          const list = nextAll[limit.kind] ?? []
          if (list[list.length - 1]?.percent !== limit.percentUsed) {
            nextAll[limit.kind] = [...list, { at, percent: limit.percentUsed }].slice(-MAX_SAMPLES)
          }
        }

        return nextAll
      })
      await checkAlert($, e.context.percent)
      // The day's cost follows the session's running total, so it matches the cost panel.
      if (e.cost !== undefined) await recordDay($, { usd: e.cost.usd })
    } catch {
      // A missed reading only blurs the forecast.
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const began = await $.clock.now()
    const ran = await next(e)

    try {
      const ms = (await $.clock.now()) - began
      const name = toolLabel(String(e.tool))
      const isDenied = ran.deny !== undefined
      const isError = !isDenied && ran.isError === true
      await update($, tools, all => {
        const stat = all[name] ?? ZERO_TOOL

        return {
          ...all,
          [name]: {
            calls: stat.calls + 1,
            errors: stat.errors + (isError ? 1 : 0),
            denied: stat.denied + (isDenied ? 1 : 0),
            totalMs: stat.totalMs + ms,
            maxMs: Math.max(stat.maxMs, ms),
          },
        }
      })

      const input = e as unknown as Record<string, unknown>
      if (e.agentId === undefined) await update($, timing, was => ({ ...was, toolMs: was.toolMs + ms }))

      const path = input.file_path ?? input.notebook_path
      if (FILE_TOOLS.has(String(e.tool)) && typeof path === 'string' && !isDenied) {
        const isRead = e.tool === 'Read'
        const at = await $.clock.now()
        await update($, files, all => {
          const was: FileStat = all[path] ?? { reads: 0, edits: 0, lastAt: 0 }
          const grown = { ...all, [path]: { reads: was.reads + (isRead ? 1 : 0), edits: was.edits + (isRead ? 0 : 1), lastAt: at } }

          return Object.keys(grown).length <= MAX_FILES
            ? grown
            : Object.fromEntries(Object.entries(grown).sort(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, MAX_FILES))
        })
      }

      if (e.tool === 'Bash' && typeof input.command === 'string') {
        const key = commandKey(input.command)
        await update($, commands, all => {
          const was: CommandStat = all[key] ?? { calls: 0, errors: 0, totalMs: 0 }
          const grown = { ...all, [key]: { calls: was.calls + 1, errors: was.errors + (isError || isDenied ? 1 : 0), totalMs: was.totalMs + ms } }

          return Object.keys(grown).length <= MAX_COMMANDS
            ? grown
            : Object.fromEntries(Object.entries(grown).sort(([, a], [, b]) => b.totalMs - a.totalMs).slice(0, MAX_COMMANDS))
        })
      }
    } catch {
      // The panel misses one call; the call itself already ran and stands.
    }

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const { agentId } = spawned

    if (agentId !== undefined) {
      try {
        const row: AgentRow = {
          id: agentId,
          type: e.subagentType,
          description: e.description,
          model: spawned.model ?? '',
          status: 'running',
          startedAt: await $.clock.now(),
        }
        await update($, agents, list => [...list.filter(one => one.id !== agentId), row].slice(-MAX_AGENTS))
      } catch {
        // Same as above: the spawn stands whatever the panel does.
      }
    }

    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    try {
      const spent = e.usage
      if (spent !== undefined) {
        await update($, tokens, total => ({
          input: total.input + spent.input_tokens,
          output: total.output + spent.output_tokens,
          cacheRead: total.cacheRead + spent.cache_read_input_tokens,
          cacheWrite: total.cacheWrite + spent.cache_creation_input_tokens,
          turns: total.turns + (e.agentId === undefined ? 1 : 0),
        }))
      }

      if (e.agentId !== undefined) {
        if (spent !== undefined) {
          await recordDay($, {
            tokensIn: spent.input_tokens + spent.cache_read_input_tokens + spent.cache_creation_input_tokens,
            tokensOut: spent.output_tokens,
          })
        }
        const status = agentState(e.reason)
        await update($, agents, list =>
          list.map(one => (one.id === e.agentId ? { ...one, status, durationMs: e.durationMs } : one)),
        )
      } else {
        const now = await $.session.usage()
        const percent = now.context.percent
        if (percent !== undefined) await update($, history, list => [...list, percent].slice(-HISTORY))
        const usd = now.cost?.usd
        if (usd !== undefined) await update($, costs, list => [...list, usd].slice(-HISTORY))
        if (spent !== undefined) await update($, model, () => spent.model)
        await update($, timing, was => ({ turnMs: was.turnMs + e.durationMs, toolMs: was.toolMs, turns: was.turns + 1 }))

        await recordDay($, {
          usd,
          tokensIn: spent === undefined ? 0 : spent.input_tokens + spent.cache_read_input_tokens + spent.cache_creation_input_tokens,
          tokensOut: spent?.output_tokens ?? 0,
          turns: 1,
        })
      }
    } catch {
      // A missed sample only thins the graphs.
    }

    return done
  })

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    const action = parseAction(e.data)
    if (action !== undefined) await change($, action)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snapshot: Snapshot = {
      now: await $.clock.now(),
      startedAt: await read($, startedAt),
      model: await read($, model),
      columns: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      usage: await read($, usage),
      history: await read($, history),
      costs: await read($, costs),
      tokens: await read($, tokens),
      tools: await read($, tools),
      agents: await read($, agents),
      prefs: await read($, prefs),
      cwd: await read($, cwd),
      files: await read($, files),
      commands: await read($, commands),
      timing: await read($, timing),
      samples: await read($, samples),
      days: await read($, days),
    }

    if (e.surface === 'terminal') {
      const { Client } = $.ui.resolve(e)

      return <Client key="top" module="./tui.tsx" props={snapshot} flexGrow={1} />
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)

    return drawDesktop({ Box, Text, Button, Svg }, snapshot, snapshot.now, action => void change($, action))
  })
}
