import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View } from '../types'

// Was die Leiste zeigt; jede Änderung zeichnet sie neu.
const view = atom({ plugin: 'budget-guard', key: 'view' } as const, null)
const STATS = 'budget-guard-stats'

type Sample = { t: number; used: number }

// $.store teilen sich alle laufenden Sessions dieses Rechners live (gemessen).
async function load($: EngineInterface): Promise<Sample[]> {
  const list = await $.store.get('samples')
  return Array.isArray(list) ? list : []
}

// Anstiege im Fenster. Liegt zwischen zwei Messwerten der Fensteranfang, zählt
// nur der Anteil im Fenster (gleichmäßig verteilt angenommen). Ein Wochen-Reset
// (Wert fällt) zählt 0.
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

// Behält den Verlauf plus den letzten Wert davor. Gleiche Werte in Folge werden
// auf Anfang und Ende der Strecke verkürzt; die Rechnung bleibt dieselbe.
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

// Rechnet aus dem gemeinsamen Protokoll, setzt bei Überschreitung die Sperre
// (hält für alle Sessions, bis /budget-guard-reset) und aktualisiert die Leiste.
async function check($: EngineInterface, windowMs: number, max: number): Promise<{ spent: number; stopped: boolean }> {
  const list = await load($)
  const now = await $.clock.now()
  // Nach /budget-guard-reset zählt nur, was danach kam.
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

function openStats($: EngineInterface) {
  return $.ui.open({ id: STATS, title: 'Budget-Statistik' })
}

const DAY_MS = 24 * 3_600_000
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

function dayLabel(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`
}

// Anstiege je Kalendertag (die letzten `days`) und je Uhrzeit, in Ortszeit.
// ponytail: ein Anstieg zählt ganz zur Zeit des Messwerts, der ihn zeigt; nach langen Lücken ohne Messwert anteilig verteilen, falls das verzerrt.
function distribution(list: Sample[], now: number, days: number) {
  const perDay = new Map<string, number>()
  const today = new Date(now)
  // Über das Datum gezählt, nicht in 24-h-Schritten: Zeitumstellungen überspringen sonst einen Tag.
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
  return ` · Reset ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const register: Register = (on, options) => {
  // Nutzer-Config: nur positive Zahlen, sonst Standard (0 hieße Dauersperre bzw. nie messen).
  const positive = (v: unknown, fallback: number) => (Number(v) > 0 ? Number(v) : fallback)
  const max = positive(options.maxPercent, 10)
  const hours = positive(options.windowHours, 5)
  const windowMs = hours * 3_600_000
  // Verlauf zum späteren Nachsehen, mindestens aber das Fenster.
  const historyDays = Math.round(positive(options.historyDays, 7))
  const keepMs = Math.max(windowMs, historyDays * DAY_MS)
  let mainTurn: string | undefined

  const reason = (s: number) =>
    `budget-guard: Konto hat in ${hours} h ${Math.round(s)} von max. ${max} Prozentpunkten des Wochenlimits verbraucht. ` +
    `Alle Agents sind pausiert; nichts weiter tun. Nur der Mensch kann das mit /budget-guard-reset lösen.`

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'budget-guard-reset',
      description: 'Budget-Guard für alle Sessions freigeben: das Fenster ab jetzt neu zählen',
    })
    await $.command.register({ name: STATS, description: 'Budget-Guard: Verbrauch je Tag und Uhrzeit anzeigen' })
    await check($, windowMs, max)
    // Fenster gleitet und andere Sessions messen mit: jede Minute neu rechnen (lokal, keine Tokens).
    $.clock.every(60_000, () => void check($, windowMs, max))
    return next(e)
  })

  on('command.run', { command: 'budget-guard-reset' }, async $ => {
    await $.store.set('since', await $.clock.now())
    await $.store.set('stopped', false)
    await check($, windowMs, max)
    return { text: `budget-guard: freigegeben, zählt ab jetzt neu (max. ${max} Punkte in ${hours} h).` }
  })

  on('command.run', { command: STATS }, async $ => {
    await openStats($)
    return { text: 'budget-guard: Statistik geöffnet.' }
  })

  on('ui.render', { component: 'Pane', requestId: STATS }, async ($, e) => {
    await read($, view) // zeichnet neu, sobald ein Messwert kommt
    const { Box, Text } = $.ui.resolve(e)
    const { perDay, perHour } = distribution(await load($), await $.clock.now(), historyDays)
    const top = Math.max(1, ...perDay.map(([, v]) => v))
    return (
      <Box flexDirection="column">
        <Text bold>Je Tag (Prozentpunkte des Wochenlimits)</Text>
        {perDay.map(([day, v]) => (
          <Text>
            <Text dimColor>{day} </Text>
            <Text color="success">{bar(v, top)}</Text>
            <Text> {v}</Text>
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Je Uhrzeit</Text>
        <Text color="success">{spark(perHour)}</Text>
        <Text dimColor>0     6     12    18   23</Text>
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
      // ponytail: kein Lock; ein gleichzeitiger Schreiber kann einen Messwert verlieren, der nächste holt ihn nach.
      const list = prune(
        [...(await load($)), { t: now, used: week.percentUsed }].sort((a, b) => a.t - b.t),
        now,
        keepMs,
      )
      await $.store.set('samples', list)
      await update($, view, v => ({ spent: v?.spent ?? 0, stopped: v?.stopped ?? false, week: week.percentUsed, resetsAt: week.resetsAt ?? null }))
      const { spent: s, stopped } = await check($, windowMs, max)
      if (stopped) {
        $.ui.toast(reason(s))
        if (mainTurn) await $.turn.abort({ turnId: mainTurn }).catch(() => {})
      }
    }
    return next(e)
  })

  // Vor jeder Modellanfrage, auch der von Subagents: über Budget beantwortet der
  // Guard selbst und beendet den Turn. Keine Anfrage an die API, keine Tokens.
  on('turn.step', async function* ($, e, next) {
    const { spent: s, stopped } = await check($, windowMs, max)
    if (!stopped) return yield* next(e)
    const text = reason(s)
    yield { kind: 'text', index: 0, text }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Greift auch bei Subagents und in Sessions, die selbst nichts gemessen haben.
  on('tool.call', async ($, e, next) => {
    const { spent: s, stopped } = await check($, windowMs, max)
    return stopped ? { deny: reason(s) } : next(e)
  }).catch(($, e, next) => next(e)) // ein Fehler im Guard soll nicht alles blockieren

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
          {v.week === null ? '' : ` · Woche ${v.week}%`}
          {resetText(v.resetsAt)}
        </Text>
      </Text>
    )
    const row = (
      <Box>
        {line}
        <Text> </Text>
        <Button key="stats" label="Statistik" plain dimColor onPress={() => void openStats($)} />
      </Box>
    )
    if (!v.stopped) return row
    return (
      <Box flexDirection="column">
        {row}
        <Text color="error">Budget-Guard: alle Agents pausiert, keine Anfragen gehen raus.</Text>
        <Text>
          Lösen: <Text bold>/budget-guard-reset</Text>
        </Text>
      </Box>
    )
  })
}
