---
name: harness
description: "Multi-agent orchestration system. Splits tasks into subtasks, runs Developer/Reviewer/Tester agents in parallel Git worktrees, retries on failure, integrates and delivers. Trigger: /harness"
---

# Harness: Local Multi-Agent Orchestration

You are the orchestrator. You do NOT write business code. You plan, dispatch, monitor, and deliver.

## Commands

- `/harness "<requirement>"` — Start a new task
- `/harness status` — Show current task progress
- `/harness cleanup <taskId>` — Remove worktrees for a completed/failed task
- `/harness cleanup --completed` — Remove all completed task worktrees

## Quick Start

When the user triggers `/harness "<requirement>"`:

1. Load configuration from `.swarm/config.yaml` (or use defaults).
2. Check Git readiness (init if needed).
3. Load or create task state in `.swarm/state/`.
4. If resuming an existing task, pick up from current state.
5. If new task, run the Planner to decompose into subtasks.
6. Execute subtasks respecting dependencies and concurrency limits.
7. For each subtask: Developer → Reviewer → Tester (retry on failure, max 3 retries).
8. Integrate all passing subtask branches.
9. Deliver to user's working directory.
10. Output final report.

## Status Command

When the user triggers `/harness status`:

1. Read `.swarm/state/task.json` and all subtask status files.
2. Output formatted progress summary.
3. If no active task, report "没有正在执行的任务".

## Configuration

### Loading Priority

1. Read `.swarm/config.yaml` in the project directory.
2. If not found, use built-in defaults:
   - `maxConcurrency`: 3
   - `retryLimit`: 3
   - `timeoutMs`: 600000
   - `agents.default`: uses the current session's model (no env override)
   - `delivery.strategy`: auto_merge

### Agent Config Resolution

For each role (developer, reviewer, tester):
1. If `agents.<role>` is defined with all 4 fields (provider, baseUrl, apiKey, model), use it.
2. Otherwise use `agents.default`.
3. If `agents.default` is not defined, sub-agents inherit the current session's environment (no env vars injected).

### Reading Config

Before starting any task, read the config:

```bash
cat .swarm/config.yaml 2>/dev/null
```

Parse the YAML content. Store resolved config in memory for the session.

## State Management

All state lives in `.swarm/state/`. The orchestrator reads state before every decision and writes state after every action.

### Initialize Task State

When starting a new task, create `.swarm/state/task.json`:

```bash
mkdir -p .swarm/state/subtasks
```

Write to `.swarm/state/task.json`:

```json
{
  "taskId": "<generated-id>",
  "description": "<user requirement>",
  "status": "pending",
  "subtasks": [],
  "dependencies": {},
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

Task ID format: `task_<YYYYMMDD>_<HHmmss>` (e.g., `task_20260522_103000`).

### Initialize Subtask State

For each subtask, create `.swarm/state/subtasks/<subtaskId>/status.json`:

```json
{
  "subtaskId": "<id>",
  "taskId": "<parent task id>",
  "status": "pending",
  "currentRole": null,
  "attempt": 0,
  "worktreePath": ".swarm/worktrees/<taskId>/<subtaskId>",
  "branch": "swarm/<taskId>/<subtaskId>",
  "commitSha": null,
  "updatedAt": "<ISO timestamp>"
}
```

### Update State

After each role execution, write the role output file:

- `.swarm/state/subtasks/<subtaskId>/developer.json`
- `.swarm/state/subtasks/<subtaskId>/reviewer.json`
- `.swarm/state/subtasks/<subtaskId>/tester.json`

And update `status.json` with new status, currentRole, attempt, commitSha.

### Read State (for resume)

On `/harness` trigger, check if `.swarm/state/task.json` exists:
- If yes and status is "running" or "pending": resume from current state.
- If yes and status is "passed" or "failed" or "suspended": report status, ask user what to do.
- If no: start fresh.

## Git Project Preparation

Before any task execution, ensure the project directory is Git-ready.

### Check Git Status

```bash
git rev-parse --git-dir 2>/dev/null
```

### Case 1: Not a Git repo (command fails)

```bash
git init
git config user.name "Harness"
git config user.email "harness@local"
git add -A
git commit -m "chore: baseline commit (auto-created by harness)"
```

Output: `[harness] Git 仓库已自动初始化`

### Case 2: Already a Git repo (command succeeds)

Read current branch and HEAD:

```bash
git branch --show-current
git rev-parse HEAD
```

Check for uncommitted changes:

```bash
git status --porcelain
```

If there are uncommitted changes, record them but do NOT modify them. The delivery step will check for conflicts later.

Output: `[harness] Git 仓库就绪，当前分支: <branch>, HEAD: <short-sha>`

### Store Base Info

Remember the base branch and HEAD SHA — these are needed for integration later:
- `baseBranch`: the branch the user was on when `/harness` was triggered
- `baseCommit`: the HEAD SHA at that moment

### Sub-Agent Sandbox Setup (one-time per task)

Sub-agent invocations require an isolated `HOME` so the `claude` CLI cannot fall back to the user's `~/.claude/settings.json`. Create this once at task start:

```bash
mkdir -p .swarm/agent-home/.claude
echo '{}' > .swarm/agent-home/empty-settings.json
```

Also locate and remember the absolute path to the real `claude.exe` (the wrapper on PATH may be different from the binary that actually runs). Run `claude doctor` once and capture the `Path:` line value. Typical values:

- Windows + nvm: `C:/Users/<user>/AppData/Roaming/nvm/v<ver>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
- Windows + system node: `C:/Program Files/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
- macOS / Linux: typically `which claude` returns the actual binary

Store this path as `claudeBin` for the session — every sub-agent dispatch uses it instead of bare `claude`. See "Build Command" below for why this is necessary.

## Worktree Manager

### Create Subtask Worktree

For each subtask, create an isolated worktree:

```bash
mkdir -p .swarm/worktrees/<taskId>
git worktree add .swarm/worktrees/<taskId>/<subtaskId> -b swarm/<taskId>/<subtaskId>
```

Output: `[harness] [<subtaskId>] Worktree 已创建: .swarm/worktrees/<taskId>/<subtaskId>`

If the branch already exists (resume scenario):

```bash
git worktree add .swarm/worktrees/<taskId>/<subtaskId> swarm/<taskId>/<subtaskId>
```

### Create Integration Worktree

```bash
git worktree add .swarm/worktrees/<taskId>/integration -b swarm/<taskId>/integration
```

### List Worktrees

```bash
git worktree list
```

### Remove Worktree

```bash
git worktree remove .swarm/worktrees/<taskId>/<subtaskId> --force
git branch -D swarm/<taskId>/<subtaskId>
```

### Clean After Tester

After Tester completes (pass or fail), clean uncommitted files in the worktree AND nuke `node_modules` to release disk:

```bash
cd .swarm/worktrees/<taskId>/<subtaskId>
git checkout -- .
git clean -fd
# node_modules is gitignored so `git clean -fd` won't touch it. Nuke it explicitly —
# the lockfile is committed, so any later step that actually needs deps can re-install.
find . -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null
find . -type d -name dist -prune -exec rm -rf {} + 2>/dev/null
```

Why nuke `node_modules`: a typical `frontend/node_modules` is ~40MB and a `backend/node_modules` is ~3MB. Across 4 subtask worktrees + 1 integration worktree, leftover deps can easily occupy 100MB+ of disk for code that's already merged. The `package-lock.json` is committed, so any consumer that actually needs the deps can rerun `npm install` deterministically. This removes test artifacts (coverage reports, temp files) and dependency caches without affecting committed code.

## Claude Code Runner

### Resolve Agent Config

For a given role, resolve the LLM configuration:

1. Check if `agents.<role>` is defined in config with all 4 fields.
2. If not, use `agents.default`.
3. If neither exists, don't inject env vars (use session defaults).

### Build Command

**CRITICAL — three-piece isolation suite.** On Windows (and likely macOS/Linux too) the `claude` CLI silently overrides any env you inject from three other sources:
1. The parent process's already-loaded env (the orchestrator inherits `ANTHROPIC_*` from `~/.claude/settings.json`'s `env` block, and so do all its child shells).
2. `~/.claude/settings.json`'s `env` block (re-applied by the CLI on startup).
3. Any OAuth credential in `~/.claude/.credentials.json` or OS keychain (takes precedence over `ANTHROPIC_AUTH_TOKEN`).

Just doing `ANTHROPIC_BASE_URL=... claude -p ...` will appear to work but actually keep using the parent's LLM. To make `agents.<role>` config in `.swarm/config.yaml` actually take effect, all three of the following are required together (omit any one and override fails silently):

**(a) Scrub inherited `ANTHROPIC_*` vars before exporting our own.**
**(b) Pass `--bare` so OAuth/keychain are never read.**
**(c) Pass `--settings <path-to-empty-json-file>` so `~/.claude/settings.json` is replaced with `{}`.**
**(d) Redirect `HOME` and `USERPROFILE` to a clean directory (e.g. `.swarm/agent-home/`) so the CLI cannot fall back to the user's `.claude/` config.**

Once on session startup, prepare the sandbox:

```bash
mkdir -p .swarm/agent-home/.claude
echo '{}' > .swarm/agent-home/empty-settings.json
```

(Re-using these between subtasks is fine; they only need to exist.)

Per sub-agent invocation, the full command is:

```bash
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
      ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL \
      ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_REASONING_MODEL \
      ANTHROPIC_API_KEY
cd "<worktree-absolute-path>" && \
HOME="<abs-path-to>/.swarm/agent-home" \
USERPROFILE="<windows-abs-path-to>\\.swarm\\agent-home" \
ANTHROPIC_BASE_URL="<baseUrl>" \
ANTHROPIC_AUTH_TOKEN="<apiKey>" \
ANTHROPIC_MODEL="<model>" \
"<absolute-path-to>/claude.exe" \
  --bare \
  --settings "<windows-abs-path-to>\\.swarm\\agent-home\\empty-settings.json" \
  -p "<prompt>" \
  --permission-mode bypassPermissions \
  --allowedTools "Bash Read Write Edit Glob Grep" \
  --output-format text
```

Notes:
- Use the **absolute path to the real `claude.exe` binary** (e.g. `C:/Program Files/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe`) instead of bare `claude`. On systems with cc-switch, nvm, or multiple node installs, `claude` on PATH may be a wrapper that resolves to a different binary than the one configured. Locate it once with `claude doctor` (look for the `Path:` line) and remember it for the session.
- USERPROFILE needs the **Windows-style absolute path** (with backslashes); HOME needs the **Unix-style path** (forward slashes). On non-Windows, set HOME only.
- `--settings` requires the file to exist; an empty `{}` is enough.
- `--bare` disables hooks, plugin sync, auto-memory, keychain, and OAuth. The sub-agent's prompt must therefore include any context it would normally have inherited (CLAUDE.md content is not auto-loaded under `--bare`).
- `ANTHROPIC_AUTH_TOKEN` sends `Authorization: Bearer`, required by Anthropic-compatible proxies (DeepSeek, etc.). `ANTHROPIC_API_KEY` sends `x-api-key` which many proxies reject.
- If `agents.<role>` and `agents.default` are both absent, you may instead let the sub-agent inherit the parent session auth: skip the three-piece suite entirely and just run `claude -p ...`. But do not mix the two — a partial isolation will appear to work and silently route to the parent LLM.

**How to verify the isolation actually works** (run once after editing config or moving to a new machine): set `ANTHROPIC_BASE_URL` to a deliberately invalid URL like `https://this-host-does-not-exist-xyz123.invalid` and run a sub-agent command. If the isolation is correct the CLI must report a network error (`Unable to connect to API`, `ENOTFOUND`, etc.). If it returns a normal LLM reply, isolation is broken — the sub-agent is silently using the parent's LLM and the route is wrong. **LLM self-reports of "I am Claude/DeepSeek" are unreliable; only network-level errors prove which endpoint was actually hit.**

### Execute and Capture Output

Run the command via Bash tool with timeout:

```bash
timeout <timeoutSeconds> bash -c '<full command>' 2>&1
```

On Windows (PowerShell context via Git Bash):
```bash
timeout <timeoutSeconds> <full command>
```

### Handle Timeout

If the process exceeds `timeoutMs`:
1. Kill the process.
2. Write a failed status with summary "执行超时".
3. Count as a failed attempt.

### Read Result

After the sub-agent exits, read the output JSON file:

```bash
cat .swarm/state/subtasks/<subtaskId>/<role>.json
```

If the file doesn't exist or is malformed, treat as failure with summary "子 Agent 未输出有效结果".

## Concurrency and Queue Management

### Dependency Batching

Given the dependency graph from the planner, group subtasks into batches:

- Batch 0: subtasks with no dependencies (can all start immediately)
- Batch 1: subtasks whose dependencies are all in batch 0
- Batch N: subtasks whose dependencies are all in batches < N

Execute batches in order. Within a batch, run subtasks concurrently up to `maxConcurrency`.

### Execution Queue

Within a batch:

1. Start up to `maxConcurrency` subtasks simultaneously.
2. When a subtask completes (passes all 3 roles), release its slot.
3. If there are remaining subtasks in the current batch, start the next one.
4. Only move to the next batch when ALL subtasks in the current batch have passed.

### Parallel Execution

To run multiple sub-agents in parallel, launch them as background Bash processes. Each launch must include the **full three-piece isolation suite** described in "Build Command" above; abbreviating any of `unset`, `--bare`, `--settings`, or `HOME`/`USERPROFILE` redirection will silently route that sub-agent to the parent's LLM.

```bash
# One-time per session: prepare the sandbox HOME
mkdir -p .swarm/agent-home/.claude
echo '{}' > .swarm/agent-home/empty-settings.json

# Launch subtask A
( unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
        ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL \
        ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_REASONING_MODEL \
        ANTHROPIC_API_KEY; \
  cd "<worktree-A-abs-path>" && \
  HOME="<abs>/.swarm/agent-home" USERPROFILE="<win-abs>\\.swarm\\agent-home" \
  ANTHROPIC_BASE_URL="..." ANTHROPIC_AUTH_TOKEN="..." ANTHROPIC_MODEL="..." \
  "<abs-path-to>/claude.exe" --bare --settings "<win-abs>\\.swarm\\agent-home\\empty-settings.json" \
    -p "..." --permission-mode bypassPermissions --allowedTools "Bash Read Write Edit Glob Grep" --output-format text ) \
  > .swarm/state/subtasks/subtask-a/stdout.log 2>&1 &
PID_A=$!

# Launch subtask B
( unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
        ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL \
        ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_REASONING_MODEL \
        ANTHROPIC_API_KEY; \
  cd "<worktree-B-abs-path>" && \
  HOME="<abs>/.swarm/agent-home" USERPROFILE="<win-abs>\\.swarm\\agent-home" \
  ANTHROPIC_BASE_URL="..." ANTHROPIC_AUTH_TOKEN="..." ANTHROPIC_MODEL="..." \
  "<abs-path-to>/claude.exe" --bare --settings "<win-abs>\\.swarm\\agent-home\\empty-settings.json" \
    -p "..." --permission-mode bypassPermissions --allowedTools "Bash Read Write Edit Glob Grep" --output-format text ) \
  > .swarm/state/subtasks/subtask-b/stdout.log 2>&1 &
PID_B=$!

# Wait for all
wait $PID_A $PID_B
```

After all processes in the concurrent batch complete, read each subtask's result file and decide next steps.

### Sequential Fallback

If `maxConcurrency` is 1, execute subtasks one at a time within each batch. The logic is the same, just no parallel launches.

## Harness Orchestration Flow

This is the main execution loop. Follow these steps exactly.

### Phase 1: Planning

1. Output: `[harness] 任务开始: <requirement>`
2. Read project file tree (top 3 levels): `find . -maxdepth 3 -type f | grep -v node_modules | grep -v .git`
3. Load the planner prompt template (check `.swarm/prompts/planner.md` first, fall back to skill default).
4. Render the template with: requirement, projectPath, fileTree.
5. Use the Agent tool to invoke the planner (lightweight LLM call, not a separate process).
6. Parse the planner's JSON output into subtasks and dependencies.
7. Write `task.json` with subtask list and dependencies.
8. Create `status.json` for each subtask.
9. Output the plan for user confirmation:

```
[harness] 规划完成，共 <N> 个子任务：

  #  ID                  标题                依赖
  1  backend-auth        后端认证模块         (无)
  2  backend-api         后端业务 API         backend-auth
  3  frontend-login      前端登录页           backend-auth
  4  frontend-dashboard  前端仪表盘           backend-api

并发批次：
  Batch 0（立即执行）: backend-auth
  Batch 1（并发）:     backend-api, frontend-login
  Batch 2（并发）:     frontend-dashboard

是否开始执行？(y/n)
```

10. Wait for user input. If user inputs anything other than `y` / `yes` / `Y`, output `[harness] 已取消` and stop.
11. Output: `[harness] 开始执行...`

### Phase 2: Worktree Setup

For each subtask:
1. Create worktree and branch.
2. Update subtask `status.json` with worktreePath and branch.

### Phase 3: Execution Loop

For each dependency batch (in order):
1. Identify subtasks in this batch that are pending or need retry.
2. For each subtask (respecting maxConcurrency):
   a. Set status to "running", currentRole to "developer", increment attempt.
   b. Output: `[harness] [<subtaskId>] Developer 执行中 (attempt <N>)...`
   c. Render developer prompt with task info (include failure info if retry). Load template: check `.swarm/prompts/developer.md` first, fall back to skill default.
   d. Launch claude process in the subtask's worktree.
   e. Read developer.json result.
   f. If developer failed: check retry limit. If under limit, go to step (a). If at limit, set status to "suspended", output error, continue to next subtask.
   g. If developer passed: update status, output `[harness] [<subtaskId>] Developer 通过`
   h. Set currentRole to "reviewer".
   i. Output: `[harness] [<subtaskId>] Reviewer 执行中...`
   j. Render reviewer prompt, launch claude process. Load template: check `.swarm/prompts/reviewer.md` first, fall back to skill default.
   k. Read reviewer.json result.
   l. If reviewer failed: record failure, go back to developer (step a) with failure context.
   m. If reviewer passed: output `[harness] [<subtaskId>] Reviewer 通过`
   n. Set currentRole to "tester".
   o. Output: `[harness] [<subtaskId>] Tester 执行中...`
   p. Render tester prompt, launch claude process. Load template: check `.swarm/prompts/tester.md` first, fall back to skill default.
   q. Read tester.json result.
   r. If tester failed: clean worktree, record failure, go back to developer (step a) with failure context.
   s. If tester passed: clean worktree, set status to "passed", output `[harness] [<subtaskId>] Tester 通过 ✓`

3. After all subtasks in batch complete, check if any are suspended. If all required subtasks passed, proceed to next batch.

### Phase 4: Integration

(See Integration and Delivery section)

### Phase 5: Delivery

(See Integration and Delivery section)

### Phase 6: Report

(See Report section)

## Integration and Delivery

### Phase 4: Integration

When all subtasks have passed:

1. Output: `[harness] 所有子任务通过，开始集成...`
2. Create integration worktree:
   ```bash
   git worktree add .swarm/worktrees/<taskId>/integration -b swarm/<taskId>/integration <baseBranch>
   ```
3. Merge each subtask branch in dependency order:
   ```bash
   cd .swarm/worktrees/<taskId>/integration
   git merge swarm/<taskId>/<subtaskId> --no-edit
   ```
4. If merge conflict occurs:
   a. Get conflict diff: `git diff`
   b. Use Agent tool with integrator prompt to determine attribution.
   c. If attribution is a subtask (high/medium confidence):
      - Abort merge: `git merge --abort`
      - Return that subtask to developer with conflict context.
      - After fix, retry integration from step 3.
   d. If attribution is null (low confidence):
      - Abort merge: `git merge --abort`
      - Set task status to "suspended".
      - Output: `[harness] 集成冲突无法自动归属，任务挂起，请人工处理`
      - Stop execution.
5. After all merges succeed, run integrated Reviewer and Tester on the integration worktree.
6. If integrated review/test fails, analyze and attribute to a subtask for fixing.

### Phase 5: Delivery

After integration passes:

1. Check user's working directory for uncommitted changes:
   ```bash
   cd <projectPath> && git status --porcelain
   ```
2. If uncommitted changes exist:
   - Output: `[harness] 用户工作目录有未提交改动，无法自动合并。集成分支已就绪: swarm/<taskId>/integration`
   - Set task status to "passed" (integration succeeded, delivery blocked).
   - Skip auto-cleanup (user may want to inspect the worktrees) and stop.
3. If clean:
   ```bash
   cd <projectPath>
   git merge swarm/<taskId>/integration --no-edit
   ```
4. Output: `[harness] 交付完成 ✓ 已合并到 <baseBranch>`
5. Update task.json status to "passed".
6. **Auto-cleanup on successful delivery.** Once master/main has the merge commit, the per-subtask worktrees and branches are pure audit trail — the orchestrator deletes them immediately to reclaim disk (a single Vue/Vite worktree is ~40MB; 5 worktrees easily exceed 100MB):

   ```bash
   cd <projectPath>

   # Subtask worktrees + branches
   for SUBTASK in <subtaskId1> <subtaskId2> ...; do
     git worktree remove ".swarm/worktrees/<taskId>/$SUBTASK" --force 2>/dev/null
     git branch -D "swarm/<taskId>/$SUBTASK" 2>/dev/null
   done

   # Integration worktree + branch
   git worktree remove ".swarm/worktrees/<taskId>/integration" --force 2>/dev/null
   git branch -D "swarm/<taskId>/integration" 2>/dev/null

   # Empty parent dir
   rmdir ".swarm/worktrees/<taskId>" 2>/dev/null
   rmdir ".swarm/worktrees" 2>/dev/null
   ```

   Output: `[harness] 已自动清理 worktrees 和分支`

7. **Preserve `.swarm/state/`.** The state JSONs (`task.json`, `subtasks/*/status.json`, `developer.json`, `reviewer.json`, `tester.json`) are kept so `/harness status` can still display the run history and the final report can read role outputs. They are small (KB-scale) and are the only audit trail once worktrees are gone. Do not delete `.swarm/state/` here — `/harness cleanup --state` is the explicit user gesture for that.

   The `.swarm/agent-home/` sandbox HOME and `.swarm/config.yaml` are also kept (reused by the next task).

8. **Skip auto-cleanup if any of**:
   - Task status is `suspended` (something went wrong; user needs to inspect).
   - Delivery was blocked (step 2). User wants the integration worktree to inspect/manually merge.
   - User has explicitly opted out via config (`harness.autoCleanupOnDelivery: false` in `.swarm/config.yaml`). Default is on.

## Report

### Phase 6: Final Report

After delivery (or after task suspension):

1. Gather all subtask results from `.swarm/state/subtasks/*/`.
2. Load reporter prompt template (check `.swarm/prompts/reporter.md` first, fall back to skill default).
3. Render with task description, status, and all subtask results.
4. Use Agent tool to generate the report (lightweight LLM call).
5. Output the report directly to the terminal.
6. Save report to `.swarm/state/report.md`.

## Progress Output

### Real-time Output Format

During orchestration, output progress at every key transition:

- Task start: `[harness] 任务开始: <description>`
- Planning done: `[harness] 拆分为 <N> 个子任务: <id1>, <id2>, ...`
- Role start: `[harness] [<subtaskId>] <Role> 执行中 (attempt <N>)...`
- Role pass: `[harness] [<subtaskId>] <Role> 通过`
- Role fail: `[harness] [<subtaskId>] <Role> 失败: <one-line summary>`
- Subtask pass: `[harness] [<subtaskId>] 通过 ✓`
- Subtask suspended: `[harness] [<subtaskId>] 已挂起 (达到重试上限)`
- Integration start: `[harness] 所有子任务通过，开始集成...`
- Integration conflict: `[harness] 集成冲突，归属分析中...`
- Delivery done: `[harness] 交付完成 ✓`
- Delivery blocked: `[harness] 交付受阻: 用户工作目录有未提交改动`

### Status Command Implementation

When `/harness status` is triggered:

1. Check if `.swarm/state/task.json` exists.
2. If not: output `没有正在执行的任务`.
3. If yes: read task.json and all subtask status files.
4. Format output:

```
任务: <description>
状态: <status> (<passed count>/<total> 子任务完成)

  [<subtaskId>]  ✓ 通过 (attempt <N>)
  [<subtaskId>]  ✗ 失败 (attempt <N>, <failure summary>)
  [<subtaskId>]  ⟳ <currentRole> 执行中 (attempt <N>)
  [<subtaskId>]  ○ 等待中 (依赖: <dep1>, <dep2>)
  [<subtaskId>]  ⊘ 已挂起
```

## Cleanup

### `/harness cleanup <taskId>`

Remove worktrees and branches for a specific task:

```bash
# Remove all subtask worktrees
git worktree remove .swarm/worktrees/<taskId>/<subtaskId> --force
git branch -D swarm/<taskId>/<subtaskId>

# Remove integration worktree
git worktree remove .swarm/worktrees/<taskId>/integration --force
git branch -D swarm/<taskId>/integration

# Remove state
rm -rf .swarm/state/
rm -rf .swarm/worktrees/<taskId>/
```

Output: `[harness] 已清理任务 <taskId> 的工作区`

### `/harness cleanup --completed`

Find all tasks with status "passed" and clean them:

1. Read `.swarm/state/task.json`.
2. If status is "passed", run the cleanup above.
3. Output: `[harness] 已清理所有已完成任务的工作区`

### Safety

- Never clean tasks with status "running" or "suspended".
- If a worktree has uncommitted changes, warn and skip:
  `[harness] 跳过 <subtaskId>: 有未提交改动`
