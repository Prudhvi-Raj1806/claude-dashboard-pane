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
  recent24h: SessionView[]
}

export type Summary = {
  generatedAt: string
  today: { tokens: number }
  thisWeek: { tokens: number; start: string }
  allTime: { tokens: number; input: number; output: number; cacheRead: number; turns: number; sessions: number; costUSD: number }
  daily: { date: string; tokens: number }[]
  weekly: { weekStart: string; tokens: number }[]
  topChats: { id: string; title: string; project: string; tokens: number; turns: number; costUSD: number; lastActive: string }[]
  models: { name: string; turns: number; tokens: number }[]
}
