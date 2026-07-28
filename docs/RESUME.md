# Resuming after a laptop close / session loss

## What survives, what doesn't

| Thing | Survives lid close? |
|---|---|
| Everything under `src/`, `docs/`, `tools/` — the actual game | **Yes.** Agents write straight to disk. |
| Git history + any commit you made | **Yes.** |
| `shots/*.png` from the critic loop | **Yes.** |
| Workflow scripts (`~/.claude/projects/.../workflows/scripts/*.js`) | **Yes.** |
| Per-agent transcripts + `journal.jsonl` | **Yes.** |
| **In-flight workflow agents** | **No.** Sleep suspends the process; API calls in flight fail. |
| **`resumeFromRunId` cache** | **No.** It is same-session only. |
| Spawned `vite` / Playwright Chromium processes | **No.** They die or wake wedged. |

The important consequence: **you never lose finished work, only work an agent was mid-way
through when the lid closed.** An interrupted agent may leave a half-edited file, so always
`git status` on resume.

## Before you close the lid

```bash
cd /Users/raynos/projects/game-demos/valkyrie-chronicles-demo-opus
git add -A && git commit -m "wip: checkpoint before sleep"
```

That is the only thing that matters. If a workflow is running, you can also let it finish —
`/workflows` shows live progress — but committing first means an interrupted agent can't
lose you anything.

Optional: `caffeinate -dimsu` keeps the machine awake, but on Apple Silicon closing the lid
sleeps anyway unless you are in clamshell mode on external power + display.

## On resume

### 1. Check for half-written files

```bash
git status --short
npx vite build          # catches a truncated file instantly
find src -name '*.js' | xargs -n1 node --check
```

If a file is truncated or syntactically broken, `git checkout -- <file>` to roll it back to the
last commit and re-run whatever agent owned it.

### 2. Confirm the game still boots

```bash
node tools/shoot.mjs overview shots/overview.png --wait 3500
```

Exit 0 with an empty `errors` array = the build is healthy. Look at the PNG.

### 3. Restart the workflow

**Same session still alive** (Claude Code never quit) — cheapest path, replays completed
agents from cache and only re-runs what changed:

```
Workflow({ scriptPath: "<path printed when the workflow launched>",
           resumeFromRunId: "<run id printed when it launched>" })
```

**New session** (the usual case after a lid close) — the cache is gone, so re-run the script
fresh. Ask me to do it and name the phase you want, or just say:

> resume the Valkyrie build

and I will read `docs/ARCHITECTURE.md`, `docs/CRITIQUE_RUBRIC.md`, this file, and the current
`shots/` output, then pick up at the right phase. The scripts live in:

```
~/.claude/projects/-Users-raynos-projects-game-demos-valkyrie-chronicles-demo-opus/<session>/workflows/scripts/
```

Editing a script and re-invoking with `{scriptPath}` is the supported way to iterate — you do
not have to resend the whole thing.

### 4. Find out what a dead agent had actually done

Each workflow run has a transcript directory with one `{"type":"result"}` line per completed
agent:

```bash
cat ~/.claude/projects/-Users-raynos-*/*/subagents/workflows/wf_*/journal.jsonl \
  | node -e 'process.stdin.on("data",()=>{});' # or just read it
```

Read that before assuming an agent accomplished nothing — the file edits it made are already
on disk even if it never returned a report.

## Build phase order (so you know where to pick up)

1. ~~Core scaffold + contracts~~ — done, committed
2. ~~Subsystem build (7 parallel agents, 59 modules)~~ — done, committed `043c624`
3. Integration: `main.js` + defects S1–S15, then the boot doctor — *in progress*
4. Visual critique loop: shoot → harsh critic → fix → re-shoot, per `docs/CRITIQUE_RUBRIC.md`,
   until every shot passes all 12 axes
5. Playtest / balance / performance pass
