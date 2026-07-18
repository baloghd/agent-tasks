# agent-tasks

A git-friendly task tracker for parallel pi agents. Tasks are plain markdown
files in `tasks/{open,claimed,done}/`. Status is the directory. Claiming is an
atomic rename. Everything is text committed to git, so any number of agents
(and humans, and non-pi tools) share the same board.

## Install

Auto-discovered by pi from either location:

```bash
# per project (commit it, shared with the team):
cp -r agent-tasks /path/to/repo/.pi/extensions/

# global (all your projects):
cp -r agent-tasks ~/.pi/agent/extensions/
```

Or point settings.json at it: `"extensions": ["/path/to/agent-tasks"]`.
Use project-local if only some repos should have it; global means every repo
gets the tool and the rules.

## What agents get

A `task` tool: `list`, `new` (title, why, deps), `claim`, `drop`, `done`,
`show`. Claims stamp `claimed_by` (defaults to the session id) and
`claimed_at`. One active claim per agent is enforced.

The rules ride in the system prompt via `promptGuidelines`, so they survive
compaction and need no AGENTS.md:

1. List tasks at session start and before new work.
2. Claim before you work; never touch a task claimed by someone else.
3. Follow-ups become tickets first: create each with `task new`, present ids.
   Never ask "should I do a, b or c?" without one task per option.
4. Overlapping work: pass the overlapping ids as `deps`, explain in `why`.
5. Write Why/Acceptance so a cold agent can pick the task up with no chat history.
6. Scope grows mid-task? Create a new task, don't silently expand.
7. `task done` and reference the id in the commit message.

## What humans get

`/tasks` in the TUI: the board (open / claimed with owner and age / done).
Everything is also just files: `ls tasks/open`, `cat tasks/claimed/003-*.md`,
edit acceptance checkboxes by hand, commit.

## Concurrency model

Same machine: `rename` is atomic, so two agents claiming the same id cannot
both win; the loser gets "lost the race" and re-lists. Ids use O_EXCL create
with bump, no lock file. Across clones: both claims land in git and conflict
on merge; first pusher wins, loser drops. Stale claim from a dead session:
`task drop` (guarded to the owner, so coordinate in chat first).

## Limits (ponytail)

- `deps` are informational; no cycle checking or blocking.
- `done/` grows forever; archive by hand if it ever bothers you.
- No auto-list injection per turn; the guidelines cover it. Add a
  `before_agent_start` hook if agents start ignoring it.

## Dev

`node selfcheck.ts` runs the claim/id guard tests.
