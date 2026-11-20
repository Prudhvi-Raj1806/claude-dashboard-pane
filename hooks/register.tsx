import type { Register } from 'claude-code'

import type { Overview, SessionView, Summary } from '../types'

const HOME = 'claude-dashboard'
const ANALYTICS = 'claude-analytics'
const REFRESH_MS = 15000
const RULE = '─'.repeat(46)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Module-level values: they live as long as this module does, with no state API.
let overview: Overview | null = null
let summary: Summary | null = null
let lastError: string | null = null
let fetchedAt = 0
let fetching = false

const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n))
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const shortModel = (m: string | null) => (m ? m.replace(/^claude-/, '').replace(/-\d{8}$/, '') : '—')
const ago = (iso: string | null) => {
  if (!iso) return ''
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const ymd = (key: string) => key.split('-').map(Number) as [number, number, number]
const dayLabel = (key: string) => {
  const [y, m, d] = ymd(key)
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${d}`
}
const weekLabel = (key: string) => {
  const [, m, d] = ymd(key)
  return `Wk ${MONTHS[m - 1]} ${d}`
}
const bar = (value: number, max: number, width = 24) => {
  const n = max > 0 ? Math.round((value / max) * width) : 0
  return '█'.repeat(n) + '░'.repeat(width - n)
}
const clock = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dateLine = () => {
  const d = new Date()
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

// Parses one `node server.js --json` answer, or throws its error text.
function parse<T>(r: { exitCode: number; stdout: string; stderr: string }): T {
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`)
  return JSON.parse(r.stdout) as T
}

// Editorial pieces, drawn by plain calls (not components).
function header(Box: any, Text: any, title: string, right: string) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">{title}</Text>
        <Text dimColor>{right}</Text>
      </Box>
      <Text dimColor>{RULE}</Text>
    </Box>
  )
}

function stat(Box: any, Text: any, label: string, value: string, sub: string) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text dimColor>{label.toUpperCase()}</Text>
      <Text bold>{value}</Text>
      <Text dimColor>{sub}</Text>
    </Box>
  )
}

function line(Box: any, Text: any, key: string, left: string, right: string, opts: { dim?: boolean; color?: string } = {}) {
  return (
    <Box key={key} flexDirection="row" justifyContent="space-between">
      <Text dimColor={opts.dim} color={opts.color}>{left}</Text>
      <Text dimColor>{right}</Text>
    </Box>
  )
}

function barRow(Box: any, Text: any, key: string, label: string, value: number, max: number, right: string) {
  return (
    <Box key={key} flexDirection="row">
      <Text>{label.padEnd(16)}</Text>
      <Text color="claude">{bar(value, max)}</Text>
      <Text dimColor>{`  ${right}`}</Text>
    </Box>
  )
}

function section(Text: any, label: string) {
  return <Text bold>{label}</Text>
}

// One chat as two lines: the title with its age, then its details dimmed beneath.
function chatItem(Box: any, Text: any, s: SessionView, when: string, tone: { dim?: boolean; color?: string }, detail: string) {
  return (
    <Box key={s.id} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor={tone.dim} color={tone.color} bold={!tone.dim}>{clip(s.title, 48)}</Text>
        <Text dimColor>{when}</Text>
      </Box>
      <Text dimColor>{detail}</Text>
    </Box>
  )
}

function homeView(Box: any, Text: any, ov: Overview, sm: Summary, room: number) {
  const attention = ov.attention.map((s: SessionView) =>
    chatItem(Box, Text, s, ago(s.attention?.since ?? null),
      { color: s.attention?.kind === 'error' ? 'error' : 'warning' },
      `   ${s.attention?.text ?? ''} · ${s.project}`),
  )
  const recent = ov.recent24h.slice(0, room).map((s: SessionView) =>
    chatItem(Box, Text, s, ago(s.lastActive),
      { dim: s.status !== 'active' },
      `   ${s.status === 'active' ? '● running' : '○'}  ${s.project} · ${shortModel(s.model)} · ${compact(s.tokens)} tokens`),
  )
  const scanning = !ov.scan.complete
  return (
    <Box flexDirection="column" gap={1}>
      {header(Box, Text, 'CLAUDE', dateLine())}
      {scanning && <Text color="warning">{`Indexing transcripts ${ov.scan.done}/${ov.scan.total}…`}</Text>}
      <Box flexDirection="row" gap={3}>
        {stat(Box, Text, 'Today', compact(sm.today.tokens), 'tokens')}
        {stat(Box, Text, 'This week', compact(sm.thisWeek.tokens), `since ${weekLabel(sm.thisWeek.start)}`)}
        {stat(Box, Text, 'All time', compact(sm.allTime.tokens), `${sm.allTime.sessions} chats`)}
      </Box>
      <Box flexDirection="column">
        {section(Text, `NEEDS YOU · ${ov.attention.length}`)}
        {ov.attention.length === 0 && <Text dimColor>Nothing needs you right now.</Text>}
        {attention}
      </Box>
      <Box flexDirection="column">
        {section(Text, `LAST 24 HOURS · ${ov.recent24h.length}`)}
        {ov.recent24h.length === 0 && <Text dimColor>No chats in the last 24 hours.</Text>}
        {recent}
        {ov.recent24h.length > room && <Text dimColor>{`+ ${ov.recent24h.length - room} more`}</Text>}
      </Box>
      <Text dimColor>{`Updated ${clock()}`}</Text>
    </Box>
  )
}

function analyticsView(Box: any, Text: any, sm: Summary) {
  const dailyMax = Math.max(1, ...sm.daily.map((d) => d.tokens))
  const weeklyMax = Math.max(1, ...sm.weekly.map((w) => w.tokens))
  const topMax = Math.max(1, ...sm.topChats.map((c) => c.tokens))
  return (
    <Box flexDirection="column" gap={1}>
      {header(Box, Text, 'ANALYTICS', 'tokens = input + output')}
      <Box flexDirection="row" gap={3}>
        {stat(Box, Text, 'Today', compact(sm.today.tokens), 'input + output')}
        {stat(Box, Text, 'This week', compact(sm.thisWeek.tokens), `since ${weekLabel(sm.thisWeek.start)}`)}
        {stat(Box, Text, 'All time', compact(sm.allTime.tokens), `${compact(sm.allTime.input)} in · ${compact(sm.allTime.output)} out`)}
      </Box>
      <Text dimColor>{`Cache reads ${compact(sm.allTime.cacheRead)} · ${compact(sm.allTime.turns)} replies · $${sm.allTime.costUSD.toFixed(2)} reported`}</Text>

      <Box flexDirection="column">
        {section(Text, 'DAILY · LAST 14 DAYS')}
        {sm.daily.slice(-14).map((d) => barRow(Box, Text, d.date, dayLabel(d.date), d.tokens, dailyMax, compact(d.tokens)))}
      </Box>

      <Box flexDirection="column">
        {section(Text, 'WEEKLY · LAST 12 WEEKS')}
        {sm.weekly.map((w) => barRow(Box, Text, w.weekStart, weekLabel(w.weekStart), w.tokens, weeklyMax, compact(w.tokens)))}
      </Box>

      <Box flexDirection="column">
        {section(Text, 'MOST USED CHATS · ALL TIME')}
        {sm.topChats.slice(0, 6).map((c) => barRow(Box, Text, c.id, clip(c.title, 15), c.tokens, topMax, `${compact(c.tokens)} · ${c.project}`))}
      </Box>

      <Box flexDirection="column">
        {section(Text, 'MODELS · ALL TIME')}
        {sm.models.map((m) => line(Box, Text, m.name, shortModel(m.name), `${compact(m.tokens)} · ${compact(m.turns)} replies`))}
      </Box>
    </Box>
  )
}

async function refreshIfStale($: any) {
  if (fetching || Date.now() - fetchedAt < REFRESH_MS - 1000) return
  fetching = true
  fetchedAt = Date.now()
  try {
    const root = $.plugin.root
    const [ovR, smR] = await Promise.all([
      $.process.run(['node', `${root}/dashboard/server.js`, '--json', 'overview']),
      $.process.run(['node', `${root}/dashboard/server.js`, '--json', 'summary']),
    ])
    overview = parse<Overview>(ovR)
    summary = parse<Summary>(smR)
    lastError = null
  } catch (err) {
    lastError = (err as Error).message
  } finally {
    fetching = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dashboard', description: 'Show the Claude dashboard panes' })
    void $.ui.open({ id: HOME, title: 'Home' })
    void $.ui.open({ id: ANALYTICS, title: 'Analytics' })
    // Redraw on a timer; each redraw refreshes the data when it is stale.
    $.clock.every(REFRESH_MS, () => {
      $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async ($) => {
    await $.ui.open({ id: HOME, title: 'Home' })
    await $.ui.open({ id: ANALYTICS, title: 'Analytics' })
    return { text: 'Claude dashboard opened: Home and Analytics tabs.' }
  })

  on('ui.render', { component: 'Pane', requestId: HOME }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await refreshIfStale($)
    if (!overview || !summary) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{lastError ? `Could not load the dashboard: ${lastError}` : 'Loading…'}</Text>
        </Box>
      )
    }
    // Each chat takes three lines; keep the list inside the pane.
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 18) / 3))
    return homeView(Box, Text, overview, summary, room)
  })

  on('ui.render', { component: 'Pane', requestId: ANALYTICS }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await refreshIfStale($)
    if (!summary) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{lastError ? `Could not load analytics: ${lastError}` : 'Loading…'}</Text>
        </Box>
      )
    }
    return analyticsView(Box, Text, summary)
  })
}
