import type { Register } from 'claude-code'

import type { Analytics, Overview } from '../types'

const PANE = 'claude-dashboard'
const DAYS = [7, 14, 30, 90]
const BARS = '▁▂▃▄▅▆▇█'

const OVERVIEW = { plugin: 'claude-dashboard', key: 'overview' } as const
const ANALYTICS = { plugin: 'claude-dashboard', key: 'analytics' } as const
const VIEW = { plugin: 'claude-dashboard', key: 'view' } as const
const DAYS_REF = { plugin: 'claude-dashboard', key: 'days' } as const
const SEEN = { plugin: 'claude-dashboard', key: 'seen' } as const
const ERROR = { plugin: 'claude-dashboard', key: 'error' } as const

// Runs the dashboard server in one-shot JSON mode (dashboard/server.js --json).
async function ask(argv: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>, root: string, args: string[]): Promise<unknown> {
  const r = await argv(['node', `${root}/dashboard/server.js`, '--json', ...args])
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`)
  return JSON.parse(r.stdout)
}

const fmt = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n))
const shortModel = (m: string | null) => (m ? m.replace(/^claude-/, '').replace(/-\d{8}$/, '') : '—')
const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const spark = (vals: number[]) => {
  const max = Math.max(1, ...vals)
  return vals.map((v) => BARS[Math.min(7, Math.floor((7 * v) / max))]).join('')
}

export const register: Register = (on) => {
  let refreshNow: () => void = () => {}

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dashboard', description: 'Show the Claude dashboard pane' })
    void $.ui.open({ id: PANE, title: 'Claude' })

    const root = $.plugin.root
    const argv = (a: string[]) => $.process.run(a)
    const refresh = async () => {
      try {
        const days = (await $.state.get(DAYS_REF)).value ?? 30
        const [ov, an] = await Promise.all([
          ask(argv, root, ['overview']),
          ask(argv, root, ['analytics', String(days)]),
        ])
        const overview = ov as Overview
        // Toast only attention items that were not already shown.
        const seen = (await $.state.get(SEEN)).value ?? []
        for (const s of overview.attention) {
          if (!seen.includes(s.id)) $.ui.toast(`Claude needs you: ${s.title}`)
        }
        await $.state.set(SEEN, overview.attention.map((s) => s.id))
        await $.state.set(OVERVIEW, overview)
        await $.state.set(ANALYTICS, an as Analytics)
        await $.state.set(ERROR, null)
      } catch (err) {
        await $.state.set(ERROR, (err as Error).message)
      }
    }
    refreshNow = () => void refresh()
    void refresh()
    $.clock.every(15000, () => void refresh())

    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Claude' })
    return { text: 'Claude dashboard pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = (await $.state.get(VIEW)).value ?? 'home'
    const ov = (await $.state.get(OVERVIEW)).value ?? null
    const an = (await $.state.get(ANALYTICS)).value ?? null
    const err = (await $.state.get(ERROR)).value ?? null
    const days = (await $.state.get(DAYS_REF)).value ?? 30
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 14)

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button variant={view === 'home' ? 'primary' : 'secondary'} onPress={() => void $.state.set(VIEW, 'home')}>Home</Button>
        <Button variant={view === 'analytics' ? 'primary' : 'secondary'} onPress={() => void $.state.set(VIEW, 'analytics')}>Analytics</Button>
      </Box>
    )

    if (!ov) {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>{err ?? 'Loading…'}</Text>
        </Box>
      )
    }

    const k = ov.kpis
    const home = (
      <Box flexDirection="column">
        <Text bold>{`Active ${k.active}   Needs you ${k.attention}   Today ${k.sessionsToday} chats · ${fmt(k.turnsToday)} turns · $${k.costToday.toFixed(2)}`}</Text>
        <Text bold>{ov.attention.length ? 'Needs your action' : 'Nothing waiting on you'}</Text>
        {ov.attention.slice(0, 3).map((s) => (
          <Text key={s.id}>{`▲ ${s.title} — ${s.attention?.text ?? ''}`}</Text>
        ))}
        <Text bold>Active now</Text>
        {ov.active.length === 0 && <Text dimColor>No chats running.</Text>}
        {ov.active.slice(0, 3).map((s) => (
          <Text key={s.id}>{`● ${s.title} · ${s.project}`}</Text>
        ))}
        <Text bold>Recent</Text>
        {ov.recent.slice(0, room).map((s) => (
          <Text key={s.id} dimColor={s.status !== 'active'}>{`${s.title} · ${s.project} · ${ago(s.lastActive)}`}</Text>
        ))}
      </Box>
    )

    const analytics = an ? (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {DAYS.map((d) => (
            <Button
              key={d}
              variant={days === d ? 'primary' : 'secondary'}
              onPress={() => void $.state.set(DAYS_REF, d).then(() => refreshNow())}
            >
              {`${d}d`}
            </Button>
          ))}
        </Box>
        <Text bold>{`Chats ${an.totals.sessions}   Turns ${fmt(an.totals.turns)}   Cost $${an.totals.costUSD.toFixed(2)}`}</Text>
        <Text>{`Input ${fmt(an.totals.input)}   Output ${fmt(an.totals.output)}   Cache reads ${fmt(an.totals.cacheRead)}`}</Text>
        <Text bold>Turns per day</Text>
        <Text>{spark(an.daily.map((d) => d.turns))}</Text>
        <Text bold>Top models</Text>
        {an.models.slice(0, 3).map((m) => (
          <Text key={m.name}>{`${shortModel(m.name)}  ${fmt(m.turns)} turns`}</Text>
        ))}
        <Text bold>Top projects</Text>
        {an.projects.slice(0, 4).map((p) => (
          <Text key={p.name}>{`${p.name}  ${p.sessions} chats · ${fmt(p.turns)} turns`}</Text>
        ))}
        <Text bold>Top tools</Text>
        {an.tools.slice(0, 4).map((t) => (
          <Text key={t.name}>{`${t.name}  ${fmt(t.count)}`}</Text>
        ))}
      </Box>
    ) : (
      <Text dimColor>Loading analytics…</Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {err && <Text>{`Last refresh failed: ${err}`}</Text>}
        {view === 'home' ? home : analytics}
      </Box>
    )
  })
}
