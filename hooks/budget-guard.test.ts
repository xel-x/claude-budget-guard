import { expect, test } from 'claude-code/testing'

const week = (percentUsed: number) => ({
  context: { window: 200000 },
  rateLimits: [{ kind: 'seven_day', percentUsed }],
  changed: ['rateLimits' as const],
})
const H = 3_600_000
const RESET = { command: 'budget-guard-reset', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {} }

test('account-wide sliding window', { options: { maxPercent: 10, windowHours: 5, historyDays: 7 } }, async ($, on) => {
  let now = 1_000_000_000
  on('clock.now', () => ({ value: now }))
  let reachedApi = false
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('turn.step', async function* () {
    reachedApi = true
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'budget-guard-reset' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: {} }))
  const denied = async () => (await $.tool.call({ tool: 'Bash', command: 'ls' })).deny

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure(week(40))
  now += 1 * H
  await $.session.measure(week(46)) // +6
  expect(await denied()).toBeUndefined()
  now += 2 * H
  await $.session.measure(week(51)) // +5 → 11
  expect(await denied()).toMatch(/budget-guard/)
  now += 3 * H // the +6 is older than 5 h, the lock holds anyway
  expect(await denied()).toMatch(/budget-guard/)
  await $.command.run(RESET)
  expect(await denied()).toBeUndefined()

  // Long pause without samples: 10 h, +12. Only 5/10 of it is in the window → +6.
  now += 10 * H
  await $.session.measure(week(63))
  expect(await denied()).toBeUndefined()

  await $.session.measure(week(2)) // weekly reset does not count
  expect(await denied()).toBeUndefined()

  now += H
  await $.session.measure(week(20)) // +18
  expect(await denied()).toMatch(/budget-guard/)
  const stream = $.turn.step({ turnId: 't', index: 0, agentId: 'sub1' } as never)
  let r = await stream.next()
  while (!r.done) r = await stream.next()
  const step = r.value
  expect(reachedApi).toBe(false)
  expect(step.answer).toMatch(/budget-guard/)
  const stopped = await $.ui.mount({ plugin: 'budget-guard', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const hint = await stopped.find({ type: 'Text', text: /Lift with/ })
  expect(hint?.text).toMatch(/Lift with \/budget-guard-reset/)
  await stopped.unmount()
  await $.command.run(RESET)
  expect(await denied()).toBeUndefined()

  // History outlives window and reset; runs of equal values are shortened.
  for (let i = 0; i < 5; i++) {
    now += 60_000
    await $.session.measure(week(20))
  }
  const samples = store.get('samples') as { t: number; used: number }[]
  expect(now - samples[0]!.t > 5 * H).toBe(true)
  expect(samples.filter(s => s.used === 20).length).toBe(2)
  expect(await denied()).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'budget-guard', surface, component: 'AbovePrompt', props: BAND })
    const row = await ui.find({ type: 'Text', text: /Budget 5h/ })
    expect(row?.text).toMatch(/Budget 5h/)
    await ui.unmount()
  }
})

test('invalid config falls back to defaults', { options: { maxPercent: 0, windowHours: -1 } }, async ($, on) => {
  const store = new Map<string, unknown>()
  on('clock.now', () => ({ value: 1_000_000_000 }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'budget-guard-reset' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  const ui = await $.ui.mount({ plugin: 'budget-guard', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ type: 'Text', text: /Budget 5h/ }))?.text).toMatch(/0\/10/)
  await ui.unmount()
})

test('history length is configurable', { options: { maxPercent: 10, windowHours: 5, historyDays: 1 } }, async ($, on) => {
  let now = 1_000_000_000
  const store = new Map<string, unknown>()
  on('clock.now', () => ({ value: now }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'budget-guard-reset' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let used = 1; used <= 6; used++) {
    await $.session.measure(week(used))
    now += 10 * H
  }
  // 1 day of history: samples older than 24 h are dropped, except the last one before.
  const samples = store.get('samples') as { t: number }[]
  expect(samples.length).toBe(4)
})

test('stats pane shows usage per day and hour', { options: { historyDays: 3 } }, async ($, on) => {
  let now = new Date(2026, 10, 6, 15, 0).getTime() // Fri Nov 6, 3 pm local time
  const store = new Map<string, unknown>()
  let opened = ''
  on('clock.now', () => ({ value: now }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_, e) => ((opened = e.id), { value: { isPlaced: true } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure(week(10))
  now += H
  await $.session.measure(week(14)) // +4 on Fri at 4 pm

  const band = await $.ui.mount({ plugin: 'budget-guard', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'stats' })
  expect(opened).toBe('budget-guard-stats')
  await band.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'budget-guard', surface, component: 'Pane', requestId: 'budget-guard-stats',
      props: { title: 'Budget stats', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect((await pane.find({ type: 'Text', text: /^Fri Nov 06/ }))?.text).toMatch(/██████████ 4$/)
    expect((await pane.find({ type: 'Text', text: /^Wed Nov 04/ }))?.text).toMatch(/░ 0$/)
    expect((await pane.find({ type: 'Text', text: /^[·▁-█]{24}$/ }))?.text).toBe('·'.repeat(16) + '█' + '·'.repeat(7))
    await pane.unmount()
  }
})
