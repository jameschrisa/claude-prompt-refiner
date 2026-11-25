import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Analysis, Phase } from '../types'
import {
  EMPTY_DRAFT,
  MODEL,
  NOT_JSON,
  SYSTEM,
  buildPrompt,
  frontmatter,
  parseAnalysis,
} from './logic'
import type { Catalog } from './logic'

const PANE = 'prompt-refiner'

const phase = atom({ plugin: 'prompt-refiner', key: 'phase' } as const, 'idle' as Phase)
const error = atom({ plugin: 'prompt-refiner', key: 'error' } as const, '')
const draft = atom({ plugin: 'prompt-refiner', key: 'draft' } as const, '')
const analysis = atom(
  { plugin: 'prompt-refiner', key: 'analysis' } as const,
  null as Analysis | null,
  { shape: 'analysis-1' },
)
const answers = atom(
  { plugin: 'prompt-refiner', key: 'answers' } as const,
  {} as Record<string, string>,
  { shape: 'answers-1' },
)


// Reads every *.md under a folder and returns the agent entries it holds.
async function agentsIn($: EngineInterface, dir: string, prefix: string) {
  const out: Catalog['agents'] = []
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    try {
      const fm = frontmatter(await $.fs.read(`${dir}/${entry.name}`))
      const name = fm.name || entry.name.replace(/\.md$/, '')
      out.push({
        name: prefix ? `${prefix}:${name}` : name,
        model: fm.model || undefined,
        description: fm.description,
      })
    } catch {
      // an unreadable agent file is left out
    }
  }
  return out
}

async function buildCatalog($: EngineInterface): Promise<Catalog> {
  const home = (await $.env.get('HOME')) ?? ''
  const agents: Catalog['agents'] = [
    ...(await agentsIn($, `${home}/.claude/agents`, '')),
    ...(await agentsIn($, '.claude/agents', '')),
  ]

  try {
    const installed = JSON.parse(
      await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`),
    ) as { plugins?: Record<string, { installPath?: string }[]> }
    for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
      const pluginName = key.split('@')[0] ?? key
      const path = installs?.[0]?.installPath
      if (path) agents.push(...(await agentsIn($, `${path}/agents`, pluginName)))
    }
  } catch {
    // no plugin registry: only the folder agents are listed
  }

  const commands = (await $.command.list()) as {
    name: string
    description: string
    source: string
  }[]
  const skills = commands
    .filter(c => c.source !== 'builtin')
    .slice(0, 400)
    .map(c => ({ name: c.name, description: c.description }))

  const toolList = (await $.tool.list()) as { name: string; mcp: boolean }[]
  const tools = toolList.filter(t => !t.mcp).map(t => t.name)
  const connectors = [
    ...new Set(
      toolList
        .filter(t => t.mcp)
        .map(t => t.name.split('__')[1] ?? '')
        .filter(name => name !== ''),
    ),
  ]

  let routing = ''
  try {
    const path = `${home}/.claude/CLAUDE.md`
    if (await $.fs.exists(path)) routing = (await $.fs.read(path)).slice(0, 8000)
  } catch {
    // no routing rules
  }

  return { agents, skills, tools, connectors, routing }
}

// One press, one Sonnet call. `useAnswers` folds the person's answers in.
async function analyze($: EngineInterface, text: string, useAnswers: boolean) {
  await update($, phase, () => 'running' as Phase)
  await update($, error, () => '')
  await update($, draft, () => text)

  try {
    const catalog = await buildCatalog($)
    const given = useAnswers ? await read($, answers) : undefined
    const result = await $.model.complete({
      model: MODEL,
      system: SYSTEM,
      prompt: buildPrompt(text, catalog, given),
      maxTokens: 4000,
      timeoutMs: 120000,
    })

    if (!result.isAnswered) {
      await update($, error, () => `The model call failed (${result.reason}).`)
      await update($, phase, () => 'failed' as Phase)
      return
    }

    const parsed = parseAnalysis(result.text)
    if (parsed === null) {
      await update($, error, () => NOT_JSON)
      await update($, phase, () => 'failed' as Phase)
      return
    }

    await update($, analysis, () => parsed)
    if (!useAnswers) await update($, answers, () => ({}))
    await update($, phase, () => 'ready' as Phase)
    const opened = await $.ui.open({ id: PANE, title: 'Prompt refiner', focus: true })
    if (!opened.isPlaced) {
      $.ui.toast('No room for the pane. Widen the terminal or run /refine.')
    }
  } catch (err) {
    await update($, error, () => `Refine failed: ${String(err)}`)
    await update($, phase, () => 'failed' as Phase)
  }
}

async function start($: EngineInterface) {
  if ((await read($, phase)) === 'running') return
  const { text } = await $.prompt.read()
  if (text.trim() === '') {
    await update($, error, () => EMPTY_DRAFT)
    await update($, phase, () => 'failed' as Phase)
    return
  }
  await analyze($, text, false)
}

async function retry($: EngineInterface) {
  if ((await read($, phase)) === 'running') return
  const stored = await read($, draft)
  const { text } = await $.prompt.read()
  const use = text.trim() !== '' ? text : stored
  if (use.trim() === '') {
    await update($, error, () => EMPTY_DRAFT)
    return
  }
  await analyze($, use, false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'refine',
      description: 'Reopen the last prompt refinement without a new model call',
    })

    return next(e)
  })

  on('command.run', { command: 'refine' }, async $ => {
    if ((await read($, analysis)) === null) {
      return { text: 'Nothing to show yet. Type a draft and press Refine prompt.' }
    }
    await $.ui.open({ id: PANE, title: 'Prompt refiner', focus: true })

    return { text: 'Prompt refiner reopened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, phase)
    const problem = await read($, error)

    if (now === 'running') {
      return (
        <Box>
          <Text dimColor>Refining your prompt with Sonnet...</Text>
        </Box>
      )
    }

    return (
      <Box>
        <Box borderStyle="round" borderColor="cyan" paddingX={1}>
          <Button key="refine" label="Refine prompt" hotkey="r" plain onPress={() => start($)} />
        </Box>
        {problem !== '' && <Text color="red"> {problem} </Text>}
        {problem === NOT_JSON && (
          <Button key="retry" label="Try again" hotkey="t" onPress={() => retry($)} />
        )}
        {problem !== '' && (
          <Button
            key="dismiss"
            label="Dismiss"
            hotkey="x"
            dimColor
            onPress={() => update($, error, () => '')}
          />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const now = await read($, phase)
    const problem = await read($, error)
    const result = await read($, analysis)
    const given = await read($, answers)

    if (result === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{now === 'running' ? 'Working...' : 'No analysis yet.'}</Text>
          <Button key="close" label="Close" hotkey="c" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      )
    }

    const hasAnswer = Object.values(given).some(v => v.trim() !== '')
    const section = (title: string, rows: { name: string; why: string; model?: string }[]) =>
      rows.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold>{title}</Text>
          {rows.map(r => (
            <Text>
              {r.name}
              {r.model ? ` (${r.model})` : ''}
              <Text dimColor>: {r.why}</Text>
            </Text>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column">
        {problem !== '' && <Text color="red">{problem}</Text>}
        {now === 'running' && <Text dimColor>Working...</Text>}
        <Text bold>Clarity {result.score}/10</Text>
        <Text>{result.summary}</Text>

        {result.missing.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Missing details</Text>
            {result.missing.map(m => (
              <Text>{`- ${m}`}</Text>
            ))}
          </Box>
        )}

        {result.questions.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Questions</Text>
            {result.questions.map(q => (
              <Box flexDirection="column">
                <Text>{q.question}</Text>
                <Text dimColor>{q.why}</Text>
                <Input
                  key={`answer-${q.id}`}
                  label="Answer: "
                  placeholder="optional"
                  value={given[q.id] ?? ''}
                  onInput={value => update($, answers, a => ({ ...a, [q.id]: value }))}
                  onSubmit={value => update($, answers, a => ({ ...a, [q.id]: value }))}
                />
              </Box>
            ))}
          </Box>
        )}

        <Text bold>Execution: {result.execution.mode}</Text>
        <Text dimColor>{result.execution.reason}</Text>
        {section('Agents and models', result.agents)}
        {section('Skills', result.skills)}
        {section('Tools', result.tools)}
        {section('Connectors', result.connectors)}

        <Text bold>Refined prompt</Text>
        <Text>{result.refined}</Text>

        <Box>
          <Button
            key="use"
            label="Use refined prompt"
            hotkey="u"
            variant="primary"
            onPress={async () => {
              await $.prompt.fill({ text: result.refined, mode: 'replace' })
              await $.ui.close({ id: PANE })
              $.ui.toast('Refined prompt is in the prompt box. Edit it, then send.')
            }}
          />
          {hasAnswer && (
            <Button
              key="fold"
              label="Fold in answers"
              hotkey="f"
              onPress={async () => analyze($, await read($, draft), true)}
            />
          )}
          <Button
            key="rerun"
            label="Re-run"
            hotkey="a"
            onPress={async () => analyze($, await read($, draft), false)}
          />
          <Button key="close" label="Close" hotkey="c" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
