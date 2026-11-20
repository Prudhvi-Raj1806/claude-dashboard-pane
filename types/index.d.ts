export type Attention = { kind: 'question' | 'approval' | 'error'; text: string; since: string | null }

export type SessionView = {
  id: string
  title: string
  project: string
  entrypoint: string | null
  model: string | null
  status: 'active' | 'idle'
  lastActive: string
  userTurns: number
  tokens: number
  costUSD: number
  lastPrompt: string | null
  attention: Attention | null
}

export type Overview = {
  generatedAt: string
  scan: { complete: boolean; done: number; total: number }
  kpis: {
    active: number
    attention: number
    sessionsToday: number
    turnsToday: number
    tokensToday: number
    costToday: number
    totalSessions: number
  }
  attention: SessionView[]
  active: SessionView[]
  recent: SessionView[]
}

export type Analytics = {
  range: { days: number; from: string; to: string }
  totals: {
    sessions: number
    turns: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    costUSD: number
    tools: number
  }
  daily: { date: string; sessions: number; turns: number; input: number; output: number; costUSD: number; tools: number }[]
  models: { name: string; turns: number; input: number; output: number; cacheRead: number }[]
  entrypoints: { name: string; sessions: number; turns: number }[]
  projects: { name: string; sessions: number; turns: number; tokens: number }[]
  tools: { name: string; count: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'claude-dashboard': {
      overview: Overview | null
      analytics: Analytics | null
      view: 'home' | 'analytics'
      days: number
      seen: string[]
      error: string | null
    }
  }
}
