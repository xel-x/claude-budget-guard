import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View } from '../types'

// What the band shows; every change redraws it.
const view = atom({ plugin: 'budget-guard', key: 'view' } as const, null)
const STATS = 'budget-guard-stats'

type Sample = { t: number; used: number }

// $.store is shared live by all running sessions on this machine (measured).
async function load($: EngineInterface): Promise<Sample[]> {
  const list = await $.store.get('samples')
  return Array.isArray(list) ? list : []
}

// Increase within the window. If the window start falls between two samples,
// only the share inside the window counts (assumed evenly spread). A weekly
// reset (value drops) counts as 0.
function spentIn(list: Sample[], now: number, windowMs: number): number {
  const start = now - windowMs
  let sum = 0
  for (const [i, b] of list.entries()) {
    const a = list[i - 1]
    if (!a || b.t <= start) continue
    const d = Math.max(0, b.used - a.used)
    const dur = b.t - a.t
    sum += dur > 0 ? (d * (b.t - Math.max(a.t, start))) / dur : d
  }
  return sum
}

// Keeps the history plus the last sample before it. Runs of equal values are
// shortened to their first and last sample; the math stays the same.
function prune(list: Sample[], now: number, keepMs: number): Sample[] {
  const first = list.findIndex(s => s.t > now - keepMs)
  const kept = first === -1 ? list.slice(-1) : list.slice(Math.max(0, first - 1))
  const out: Sample[] = []
  for (const s of kept) {
    if (out.length >= 2 && out.at(-1)!.used === s.used && out.at(-2)!.used === s.used) out[out.length - 1] = s
    else out.push(s)
  }
  return out
}

// Computes from the shared log, sets the lock when over budget (holds for all
// sessions until /budget-guard-reset) and updates the band.
async function check($: EngineInterface, windowMs: number, max: number): Promise<{ spent: number; stopped: boolean }> {
  const list = await load($)
  const now = await $.clock.now()
  // After /budget-guard-reset only what came later counts.
  const since = Number((await $.store.get('since')) ?? 0)
  const spent = spentIn(list, now, Math.min(windowMs, now - since))
  let stopped = (await $.store.get('stopped')) === true
  if (!stopped && spent >= max) {
    await $.store.set('stopped', true)
    stopped = true
  }
  await update($, view, v => ({
    spent,
    stopped,
    week: list.at(-1)?.used ?? v?.week ?? null,
    resetsAt: v?.resetsAt ?? null,
  }))
  return { spent, stopped }
}

// Asks for enough rows to show everything: header lines plus one per day.
function openStats($: EngineInterface, days: number) {
  return $.ui.open({ id: STATS, title: 'Budget stats', rows: days + 6 })
}

const DAY_MS = 24 * 3_600_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayLabel(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`
}

// Increase per calendar day (the last `days`) and per hour of day, in local time.
// ponytail: an increase counts fully at the sample that shows it; spread it across long gaps without samples if that skews the picture.
function distribution(list: Sample[], now: number, days: number) {
  const perDay = new Map<string, number>()
  const today = new Date(now)
  // Counted by date, not in 24 h steps: DST changes would skip a day otherwise.
  for (let k = days - 1; k >= 0; k--) perDay.set(dayLabel(new Date(today.getFullYear(), today.getMonth(), today.getDate() - k)), 0)
  const perHour = Array<number>(24).fill(0)
  for (const [i, b] of list.entries()) {
    const a = list[i - 1]
    const d = a ? Math.max(0, b.used - a.used) : 0
    if (d === 0) continue
    const at = new Date(b.t)
    const day = dayLabel(at)
    if (perDay.has(day)) perDay.set(day, perDay.get(day)! + d)
    perHour[at.getHours()]! += d
  }
  return { perDay: [...perDay], perHour }
}

function spark(values: number[]): string {
  const top = Math.max(1, ...values)
  return values.map(v => (v === 0 ? '·' : '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((v / top) * 8))])).join('')
}

function bar(spent: number, max: number): string {
  const n = Math.max(0, Math.min(10, Math.round((spent / max) * 10)))
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

function resetText(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = WEEKDAYS[d.getDay()]
  return ` · Resets ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const register: Register = (on, options) => {
  // User config: positive numbers only, else the default (0 would mean a permanent lock or never measuring).
  const positive = (v: unknown, fallback: number) => (Number(v) > 0 ? Number(v) : fallback)
  const max = positive(options.maxPercent, 10)
  const hours = positive(options.windowHours, 5)
  const windowMs = hours * 3_600_000
  // History kept for the stats, at least as long as the window.
  const historyDays = Math.round(positive(options.historyDays, 7))
  const keepMs = Math.max(windowMs, historyDays * DAY_MS)
  let mainTurn: string | undefined

  const reason = (s: number) =>
    `budget-guard: the account used ${Math.round(s)} of max. ${max} percentage points of its weekly limit in ${hours} h. ` +
    `All agents are paused; do nothing further. Only the human can lift this with /budget-guard-reset.`

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'budget-guard-reset',
      description: 'Release budget-guard for all sessions and count the window from now',
    })
    await $.command.register({ name: STATS, description: 'Show budget-guard usage per day and hour' })
    await check($, windowMs, max)
    // The window slides and other sessions measure too: recompute every minute (local, no tokens).
    $.clock.every(60_000, () => void check($, windowMs, max))
    return next(e)
  })

  on('command.run', { command: 'budget-guard-reset' }, async $ => {
    await $.store.set('since', await $.clock.now())
    await $.store.set('stopped', false)
    await check($, windowMs, max)
    return { text: `Released, counting from now (max. ${max} points in ${hours} h).` }
  })

  on('command.run', { command: STATS }, async $ => {
    await openStats($, historyDays)
    return { text: 'Stats opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: STATS }, async ($, e) => {
    await read($, view) // redraws whenever a sample arrives
    const { Box, Text } = $.ui.resolve(e)
    const { perDay, perHour } = distribution(await load($), await $.clock.now(), historyDays)
    const top = Math.max(1, ...perDay.map(([, v]) => v))
    return (
      <Box flexDirection="column">
        <Text bold>Per hour of day</Text>
        <Text color="success">{spark(perHour)}</Text>
        <Text dimColor>0     6     12    18   23</Text>
        <Text> </Text>
        <Text bold>Per day, newest first (percentage points of the weekly limit)</Text>
        {perDay.toReversed().map(([day, v]) => (
          <Text>
            <Text dimColor>{day} </Text>
            <Text color="success">{bar(v, top)}</Text>
            <Text> {v}</Text>
          </Text>
        ))}
      </Box>
    )
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) mainTurn = e.turnId
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const week = e.rateLimits.find(r => r.kind === 'seven_day')
    if (week) {
      const now = await $.clock.now()
      // ponytail: no lock; a concurrent writer can lose a sample, the next one catches up.
      const list = prune(
        [...(await load($)), { t: now, used: week.percentUsed }].sort((a, b) => a.t - b.t),
        now,
        keepMs,
      )
      await $.store.set('samples', list)
      await update($, view, v => ({ spent: v?.spent ?? 0, stopped: v?.stopped ?? false, week: week.percentUsed, resetsAt: week.resetsAt ?? null }))
      const { spent: s, stopped } = await check($, windowMs, max)
      if (stopped) {
        $.ui.toast(reason(s).replace(/^budget-guard: /, '')) // the engine prefixes toasts with the plugin name
        if (mainTurn) await $.turn.abort({ turnId: mainTurn }).catch(() => {})
      }
    }
    return next(e)
  })

  // Before every model request, subagents included: over budget the guard answers
  // itself and ends the turn. No API request, no tokens.
  on('turn.step', async function* ($, e, next) {
    const { spent: s, stopped } = await check($, windowMs, max)
    if (!stopped) return yield* next(e)
    const text = reason(s)
    yield { kind: 'text', index: 0, text }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Also applies to subagents and to sessions that measured nothing themselves.
  on('tool.call', async ($, e, next) => {
    const { spent: s, stopped } = await check($, windowMs, max)
    return stopped ? { deny: reason(s) } : next(e)
  }).catch(($, e, next) => next(e)) // an error in the guard must not block everything

  on('prompt.submit', async ($, e, next) => {
    const { spent: s, stopped } = await check($, windowMs, max)
    return stopped && !e.command ? { drop: reason(s) } : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || v === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const ratio = v.spent / max
    const color = v.stopped || ratio >= 1 ? 'error' : ratio >= 0.7 ? 'warning' : 'success'
    const line = (
      <Text>
        <Text dimColor>Budget {hours}h </Text>
        <Text color={color}>{bar(v.spent, max)}</Text>
        <Text> {Math.round(v.spent)}/{max}</Text>
        <Text dimColor>
          {v.week === null ? '' : ` · Week ${v.week}%`}
          {resetText(v.resetsAt)}
        </Text>
      </Text>
    )
    const row = (
      <Box>
        {line}
        <Text> </Text>
        <Button key="stats" label="Stats" plain dimColor onPress={() => void openStats($, historyDays)} />
      </Box>
    )
    if (!v.stopped) return row
    return (
      <Box flexDirection="column">
        {row}
        <Text color="error">budget-guard: all agents paused, no requests go out.</Text>
        <Text>
          Lift with <Text bold>/budget-guard-reset</Text>
        </Text>
      </Box>
    )
  })
}
