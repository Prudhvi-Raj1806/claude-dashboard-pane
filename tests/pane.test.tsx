import { expect, test } from 'claude-code/testing'

const pane = (requestId: string) => ({
  plugin: 'claude-dashboard-pane',
  component: 'Pane',
  requestId,
  props: {
    title: 'Claude',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const)

const session = {
  id: 'a', title: 'Test chat', project: 'demo', entrypoint: 'claude-desktop', model: 'claude-haiku-5-5',
  status: 'idle', lastActive: '2026-11-20T09:00:00.000Z', userTurns: 2, tokens: 500, costUSD: 0.1,
  lastPrompt: null, attention: null,
}
const overview = {
  generatedAt: '2026-11-20T10:00:00.000Z',
  scan: { complete: true, done: 1, total: 1 },
  kpis: { active: 0, attention: 0, sessionsToday: 1, turnsToday: 2, tokensToday: 500, costToday: 0.1, totalSessions: 380 },
  attention: [],
  active: [],
  recent: [session],
  recent24h: [session],
}
const summary = {
  generatedAt: '2026-11-20T10:00:00.000Z',
  today: { tokens: 500 },
  thisWeek: { tokens: 2000, start: '2026-11-16' },
  allTime: { tokens: 9000, input: 4000, output: 5000, cacheRead: 1000, turns: 20, sessions: 380, costUSD: 3.5 },
  daily: [{ date: '2026-11-20', tokens: 500 }],
  weekly: [{ weekStart: '2026-11-16', tokens: 2000 }],
  topChats: [{ id: 'a', title: 'Test chat', project: 'demo', tokens: 500, turns: 2, costUSD: 0.1, lastActive: '2026-11-20T09:00:00.000Z' }],
  models: [{ name: 'claude-haiku-5-5', turns: 2, tokens: 500 }],
}

test('the home pane lists the chat from the last 24 hours', async ($, on) => {
  on('command.register', () => ({ value: { command: 'dashboard' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const body = e.argv.includes('overview') ? overview : summary
    return { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...pane('claude-dashboard'), surface: 'desktop' })
  expect((await ui.find({ type: 'Button', text: /Test chat/ }))?.text).toContain('Test chat')
  await ui.unmount()
})

test('the analytics pane shows the all-time total', async ($, on) => {
  on('command.register', () => ({ value: { command: 'dashboard' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const body = e.argv.includes('overview') ? overview : summary
    return { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...pane('claude-analytics'), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ALL TIME/ }))?.text).toContain('ALL TIME')
  await ui.unmount()
})
