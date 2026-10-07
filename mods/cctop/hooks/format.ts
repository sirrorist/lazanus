import type { Tokens } from '../types'

const SPARK = '▁▂▃▄▅▆▇█'

export type Level = 'green' | 'yellow' | 'red'

export const level = (percent: number): Level =>
  percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'green'

export const bar = (fraction: number, width: number): [string, string] => {
  const share = Math.min(1, Math.max(0, fraction))
  const filled = Math.round(share * width)

  return ['█'.repeat(filled), '░'.repeat(Math.max(0, width - filled))]
}

export const spark = (values: readonly number[], width: number, max = 100): string =>
  values
    .slice(-width)
    .map(value => {
      const share = Math.min(1, Math.max(0, value / max))

      return SPARK[Math.min(SPARK.length - 1, Math.floor(share * SPARK.length))]
    })
    .join('')

export const compact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`

  return String(Math.round(n))
}

export const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const two = (n: number) => String(n).padStart(2, '0')
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${two(Math.floor((ms % 60_000) / 1000))}s`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h${two(Math.floor((ms % 3_600_000) / 60_000))}m`

  return `${Math.floor(ms / 86_400_000)}d${two(Math.floor((ms % 86_400_000) / 3_600_000))}h`
}

export const resetsIn = (iso: string | undefined, now: number): string => {
  if (iso === undefined) return ''
  const left = Date.parse(iso) - now
  if (Number.isNaN(left)) return ''
  if (left <= 0) return 'now'
  const hours = Math.floor(left / 3_600_000)
  const minutes = Math.floor((left % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`

  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}

export const limitLabel = (kind: string): string =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? '$' : kind

export const toolLabel = (tool: string): string => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)

  return mcp ? `${mcp[1]}:${mcp[2]}` : tool
}

export const cacheHit = (tokens: Tokens): number | undefined => {
  const total = tokens.input + tokens.cacheRead + tokens.cacheWrite

  return total === 0 ? undefined : tokens.cacheRead / total
}

// Braille dots of one cell, top to bottom: the left column, then the right.
const LEFT_DOTS = [0x01, 0x02, 0x04, 0x40]
const RIGHT_DOTS = [0x08, 0x10, 0x20, 0x80]

/**
 * A filled area graph in braille, two samples per cell and four levels per
 * row, as btop draws its graphs: the newest sample on the right edge.
 *
 * @returns `height` strings of `width` cells each, the top row first
 */
export const brailleGraph = (values: readonly number[], width: number, height: number, max = 100): string[] => {
  const samples = values.slice(-width * 2)
  const padded = [...Array<number>(width * 2 - samples.length).fill(-1), ...samples]
  const levels = padded.map(value =>
    value < 0 ? 0 : Math.max(value > 0 ? 1 : 0, Math.round((Math.min(value, max) / Math.max(max, 1e-9)) * height * 4)),
  )

  return Array.from({ length: height }, (_, row) => {
    let line = ''
    for (let col = 0; col < width; col += 1) {
      let bits = 0
      for (let dot = 0; dot < 4; dot += 1) {
        // How high this dot sits, counted from the graph's floor: 1 is the lowest.
        const from = (height - row) * 4 - dot
        if ((levels[col * 2] ?? 0) >= from) bits |= LEFT_DOTS[dot] ?? 0
        if ((levels[col * 2 + 1] ?? 0) >= from) bits |= RIGHT_DOTS[dot] ?? 0
      }
      line += String.fromCodePoint(0x2800 + bits)
    }

    return line
  })
}

export const cell = (text: string, width: number, align: 'left' | 'right' = 'left'): string => {
  const cut = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text

  return align === 'left' ? cut.padEnd(width) : cut.padStart(width)
}
