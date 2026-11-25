export type Phase = 'idle' | 'running' | 'ready' | 'failed'

export type Question = { id: string; question: string; why: string }
export type Choice = { name: string; why: string }
export type AgentPick = { name: string; model: string; why: string }

export type Analysis = {
  score: number
  summary: string
  missing: string[]
  questions: Question[]
  execution: { mode: string; reason: string }
  agents: AgentPick[]
  skills: Choice[]
  tools: Choice[]
  connectors: Choice[]
  refined: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-refiner': {
      phase: Phase
      error: string
      draft: string
      analysis: Shaped<Analysis | null>
      answers: Shaped<Record<string, string>>
    }
  }
}
