import type { Analysis } from '../types'

export const MODEL = 'claude-sonnet-5-5'
export const NOT_JSON = 'The model did not return JSON.'
export const EMPTY_DRAFT = 'Type a prompt first, then press Refine prompt.'

export type Catalog = {
  agents: { name: string; model?: string; description?: string }[]
  skills: { name: string; description: string }[]
  tools: string[]
  connectors: string[]
  routing: string
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** Takes the outermost {...} of the reply and returns a clean Analysis, or null. */
export function parseAnalysis(raw: string): Analysis | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const refined = text(data.refined)
  if (refined.trim() === '') return null

  const score = Number(data.score)
  const execution = rec(data.execution)
  const pairs = (v: unknown) =>
    list(v)
      .map(rec)
      .filter(x => text(x.name) !== '')
      .slice(0, 5)
      .map(x => ({ name: text(x.name), why: text(x.why) }))

  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score))) : 0,
    summary: text(data.summary),
    missing: list(data.missing).map(text).filter(Boolean),
    questions: list(data.questions)
      .map(rec)
      .filter(x => text(x.question) !== '')
      .slice(0, 4)
      .map((x, i) => ({
        id: text(x.id) || `q${i + 1}`,
        question: text(x.question),
        why: text(x.why),
      })),
    execution: {
      mode: ['single', 'subagents', 'workflow'].includes(text(execution.mode))
        ? text(execution.mode)
        : 'single',
      reason: text(execution.reason),
    },
    agents: list(data.agents)
      .map(rec)
      .filter(x => text(x.name) !== '')
      .slice(0, 5)
      .map(x => ({ name: text(x.name), model: text(x.model), why: text(x.why) })),
    skills: pairs(data.skills),
    tools: pairs(data.tools),
    connectors: pairs(data.connectors),
    refined,
  }
}

/** Reads the leading frontmatter of a markdown file: name, description, model. */
export function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv && kv[1] !== undefined) out[kv[1]] = (kv[2] ?? '').replace(/^["']|["']$/g, '').trim()
  }
  return out
}

export const SYSTEM = [
  'You review a draft prompt that a person is about to send to Claude Code.',
  'Reply with JSON only, no prose and no code fence, in exactly this shape:',
  '{"score":0-10,"summary":"one sentence on what the draft asks","missing":["..."],"questions":[{"id":"q1","question":"...","why":"..."}],"execution":{"mode":"single|subagents|workflow","reason":"..."},"agents":[{"name":"...","model":"haiku|sonnet|opus","why":"..."}],"skills":[{"name":"...","why":"..."}],"tools":[{"name":"...","why":"..."}],"connectors":[{"name":"...","why":"..."}],"refined":"..."}',
  'Rules:',
  '- At most 4 questions. Ask only what would change the work.',
  '- Recommend agents, skills, tools and connectors ONLY from the catalog, with the exact names given, at most 5 of each. Return nothing rather than something irrelevant.',
  '- For an agent, use its pinned model when the catalog gives one; otherwise choose haiku, sonnet or opus to fit the task.',
  '- Follow the routing rules when they are given.',
  '- score is how clear and complete the draft is: 0 is unusable, 10 needs nothing.',
  '- refined keeps the intent of the draft and adds the missing details as clearly marked assumptions (for example "Assumption: ..."). Never invent facts as if the person had stated them.',
].join('\n')

export type Answered = { question: string; answer: string }

/** The questions of the current analysis that the person has answered. */
export function answeredPairs(
  questions: { id: string; question: string }[],
  answers: Record<string, string>,
): Answered[] {
  return questions
    .map(q => ({ question: q.question, answer: (answers[q.id] ?? '').trim() }))
    .filter(x => x.answer !== '')
}

/** The catalog block comes first and is cached; the draft and answers follow. */
export function buildPrompt(
  draft: string,
  catalog: Catalog,
  answered: Answered[] = [],
): { text: string; cache?: true }[] {
  const agents = catalog.agents
    .map(a => `- ${a.name}${a.model ? ` (model: ${a.model})` : ''}${a.description ? `: ${a.description.slice(0, 160)}` : ''}`)
    .join('\n')
  const skills = catalog.skills
    .map(s => `- ${s.name}${s.description ? `: ${s.description.slice(0, 120)}` : ''}`)
    .join('\n')
  const folded = answered.length
    ? `\n\nThe person answered these questions. Fold each answer into "refined" as a fact and drop the questions they settle:\n${answered.map(x => `Q: ${x.question}\nA: ${x.answer}`).join('\n')}`
    : ''

  return [
    {
      text: `ROUTING RULES:\n${catalog.routing || '(none given)'}\n\nCATALOG\nAgent types:\n${agents || '(none)'}\n\nSkills and slash commands:\n${skills || '(none)'}\n\nTools:\n${catalog.tools.join(', ') || '(none)'}\n\nConnected MCP servers:\n${catalog.connectors.join(', ') || '(none)'}`,
      cache: true,
    },
    { text: `DRAFT PROMPT:\n${draft}${folded}` },
  ]
}
