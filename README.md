# prompt-refiner

A Claude Code mod. A band above the prompt box shows a cyan-bordered **r: Refine prompt** button (hotkey `r`, reach the band with `ctrl+x tab`).

On press it reads your draft and builds a catalog of what this session has: agent types (`~/.claude/agents`, project `.claude/agents`, installed plugin agents with their plugin prefix and pinned model), skills and slash commands, tools, connected MCP servers, plus the routing rules in `~/.claude/CLAUDE.md` when that file exists. It sends the draft, catalog and rules to `claude-sonnet-5-5` through `$.model.complete` and opens a pane with:

- a clarity score and summary, the missing details, and up to four questions with answer fields
- the suggested execution mode (single, subagents, workflow)
- agents with models, skills, tools and connectors, each with a reason
- a refined prompt

Pane buttons: **Use refined prompt** (`u`, puts it in the prompt box, never sends), **Fold in answers** (`f`, when an answer is filled), **Re-run** (`a`), **Close** (`c`). `/refine` reopens the last analysis without a model call. If the model returns no JSON, the band shows **Try again** (`t`).

Each press is exactly one Sonnet call on the session's bill. No other network access. An empty draft shows an error and calls nothing.

Test: `claude plugin test .`

With the quick-ref mod installed, its lightning **q: Quick Ref** button appears in the same row and runs `/quickref`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-refiner --marketplace jameschrisa/claude-prompt-refiner
```

Press `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install prompt-refiner --marketplace jameschrisa/claude-prompt-refiner
```

Licence: MIT.
