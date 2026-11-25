import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { EMPTY_DRAFT, NOT_JSON, answeredPairs, frontmatter, parseAnalysis } from './logic'

const GOOD = {
  score: 6,
  summary: 'Fix the login bug.',
  missing: ['Which environment?'],
  questions: [{ id: 'q1', question: 'Which browser?', why: 'Repro differs' }],
  execution: { mode: 'single', reason: 'Small change' },
  agents: [{ name: 'builder', model: 'sonnet', why: 'Implements it' }],
  skills: [{ name: 'simplify', why: 'Cleanup' }],
  tools: [],
  connectors: [],
  refined: 'Fix the login bug. Assumption: staging.',
}

const PANE = {
  plugin: 'prompt-refiner',
  component: 'Pane',
  requestId: 'prompt-refiner',
  props: {
    title: 'Prompt refiner',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'prompt-refiner',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

test('parses clean JSON', () => {
  const r = parseAnalysis(JSON.stringify(GOOD))
  expect(r?.score).toBe(6)
  expect(r?.questions[0]?.id).toBe('q1')
  expect(r?.execution.mode).toBe('single')
})

test('takes the outermost braces out of prose and fences', () => {
  const r = parseAnalysis('Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```\nDone.')
  expect(r?.refined).toBe(GOOD.refined)
})

test('fails on text with no JSON, broken JSON and arrays', () => {
  expect(parseAnalysis('no json here')).toBeNull()
  expect(parseAnalysis('{"score": 5,')).toBeNull()
  expect(parseAnalysis('[1,2,3]')).toBeNull()
  expect(parseAnalysis('')).toBeNull()
})

test('clamps and defaults a sloppy reply', () => {
  const r = parseAnalysis(
    JSON.stringify({
      score: 99,
      questions: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}` })),
      agents: Array.from({ length: 9 }, (_, i) => ({ name: `a${i}` })),
      execution: { mode: 'bogus' },
      refined: 'x',
    }),
  )
  expect(r?.score).toBe(10)
  expect(r?.questions.length).toBe(4)
  expect(r?.questions[0]?.id).toBe('q1')
  expect(r?.agents.length).toBe(5)
  expect(r?.execution.mode).toBe('single')
})

test('a reply with no refined prompt counts as no JSON', () => {
  expect(parseAnalysis('{"score":5}')).toBeNull()
  expect(parseAnalysis(JSON.stringify({ ...GOOD, refined: '  ' }))).toBeNull()
})

test('only answered questions are sent, with their text', () => {
  const pairs = answeredPairs(
    [
      { id: 'q1', question: 'Which browser?' },
      { id: 'q2', question: 'Which env?' },
    ],
    { q1: ' Firefox ', q2: '  ' },
  )
  expect(pairs).toEqual([{ question: 'Which browser?', answer: 'Firefox' }])
})

test('reads agent frontmatter', () => {
  const fm = frontmatter('---\nname: scout\nmodel: haiku\ndescription: "Finds files"\n---\nBody')
  expect(fm.name).toBe('scout')
  expect(fm.model).toBe('haiku')
  expect(fm.description).toBe('Finds files')
})

function stubEngine(on: On, reply: string, prompts: string[] = [], extra: string[] = []) {
  on('command.register', () => ({ value: { command: 'refine' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({
    value: [{ name: 'scout.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', () => ({
    value: '---\nname: scout\nmodel: haiku\ndescription: Finds files\n---\nBody',
  }))
  on('fs.exists', () => ({ value: false }))
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: '', mcp: false },
      { name: 'mcp__claude_ai_Gmail__send', description: '', mcp: true },
    ],
  }))
  on('command.list', () => ({
    value: [{ name: 'simplify', description: 'Clean up', source: 'plugin' as const }, ...extra.map(name => ({ name, description: '', source: 'plugin' as const }))],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: 'fix login', cursor: 9 } }))
  on('model.complete', (_, e) => {
    prompts.push(String(e.prompt))

    return { value: { isAnswered: true, text: reply, usage: {} as never } }
  })
}

test('an empty draft shows an error and makes no model call', async ($, on) => {
  let calls = 0
  on('command.register', () => ({ value: { command: 'refine' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: '{}', usage: {} as never } }
  })
  on('prompt.read', () => ({ value: { text: '   ', cursor: 0 } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'refine' })

  expect(calls).toBe(0)
  expect(await ui.find({ type: 'Text', text: new RegExp(EMPTY_DRAFT.slice(0, 12)) })).toBeDefined()
  await ui.unmount()
})

test('the band holds the button and no hint', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', text: /Refine prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /agents, models, skills/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a reply without JSON shows the message and Try again', async ($, on) => {
  stubEngine(on, 'sorry, no')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'refine' })

  expect(await ui.find({ type: 'Text', text: /did not return JSON/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Try again/ })).toBeDefined()
  await ui.unmount()
})

test('one press is one model call, with the catalog in it', async ($, on) => {
  const prompts: string[] = []
  const filled: string[] = []
  stubEngine(on, JSON.stringify(GOOD), prompts)
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'refine' })
  await band.unmount()

  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('fix login')
  expect(prompts[0]).toContain('scout (model: haiku)')
  expect(prompts[0]).toContain('simplify')
  expect(prompts[0]).toContain('claude_ai_Gmail')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Clarity 6\/10/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Fold in answers/ })).toBeUndefined()
  await ui.press({ key: 'use' })
  expect(filled).toEqual([GOOD.refined])
  await ui.unmount()
})

test('fold in sends the question text and clears the answers', async ($, on) => {
  const prompts: string[] = []
  stubEngine(on, JSON.stringify(GOOD), prompts)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'refine' })
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'answer-q1', text: 'Firefox' })
  await ui.press({ key: 'fold' })

  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('Which browser?')
  expect(prompts[1]).toContain('Firefox')
  expect(prompts[0]).not.toContain('Firefox')
  expect(await ui.find({ type: 'Button', text: /Fold in answers/ })).toBeUndefined()
  await ui.unmount()
})

test('two quick presses make one model call', async ($, on) => {
  const prompts: string[] = []
  stubEngine(on, JSON.stringify(GOOD), prompts)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await Promise.all([band.press({ key: 'refine' }), band.press({ key: 'refine' })])
  await band.unmount()

  expect(prompts.length).toBe(1)
})

test('the Refine button carries the stars icon', async ($, on) => {
  stubEngine(on, 'x')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await ui.find({ type: 'Button', text: /\u2728 Refine prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Quick Ref/ })).toBeUndefined()
  await ui.unmount()
})

test('with the Quick Ref mod installed its button sits in the same row and runs /quickref', async ($, on) => {
  const ran: string[] = []
  stubEngine(on, 'x', [], ['quickref'])
  on('command.run', (_, e) => {
    ran.push(e.command)

    return { text: '' }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  const outer = (await ui.find({ type: 'Box' })) as { children?: { type?: string }[] }
  expect(outer.children?.filter(c => c.type === 'Box').length).toBe(2)
  await ui.press({ key: 'quickref' })

  expect(ran).toEqual(['quickref'])
  await ui.unmount()
})
