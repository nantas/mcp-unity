# Neonnew MCP Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Validate the symlinked MCP Unity package inside `/Volumes/Shuttle/unity-projects/neonnew` end-to-end through the real host-repo Codex usage path, and stop on every unexpected result until the issue is understood and resolved.

**Architecture:** Primary validation must run from an interactive `codex` session opened directly inside the host Unity project repo `/Volumes/Shuttle/unity-projects/neonnew`. This is the actual day-to-day usage path and is the only release-gating validation path for this plan. `codex exec` may still be used for compatibility observation, but it is not a release gate unless the same issue is reproduced in interactive `codex`.

**Tech Stack:** Interactive Codex CLI `codex` in host repo `/Volumes/Shuttle/unity-projects/neonnew`, optional `codex exec` for compatibility checks only, symlinked package `Packages/com.gamelovers.mcp-unity`, Unity 2022.3, MCP Unity tools (`get_scene_info`, `get_console_logs`, `send_console_log`, `run_tests`)

---

## Execution Constraint

- Do not use `git worktree` for this plan.
- Reason: the host Unity project references this package through a live symlink, and moving execution to a worktree can break the real test environment or make the host project point at the wrong checkout.
- All code changes, rebuilds, and host-project validations for this plan must run against the current source repository checkout on the current git branch.
- If a task in this plan needs source edits, edit `/Volumes/Shuttle/unity-projects/mcp-unity` directly and validate against `/Volumes/Shuttle/unity-projects/neonnew`.

## Validation Policy

- Release-gating validation path: interactive `codex` started inside `/Volumes/Shuttle/unity-projects/neonnew`
- Non-blocking compatibility path: `codex exec`
- Every validation record must state which client path was used
- A failure seen only in `codex exec` does not block this plan unless the same failure is reproduced in interactive `codex`
- Current authoritative baseline:
  - interactive `codex` in the host repo completed `run_tests(EditMode, McpUnity.Tests.MaterialToolsTests)`
  - reported result: `passCount=27`, `failCount=0`, `skipCount=0`, `timedOut=false`
  - this is the authoritative host-project MCP validation result for the current stage

## Operator Preconditions

- Keep Unity project `/Volumes/Shuttle/unity-projects/neonnew` open in the editor.
- Ensure `Tools > MCP Unity > Server Window` shows `Server Online` before Task 1 starts.
- A high connected-client count is not a failure by itself in the current design.
- If old sessions make results hard to read, manually click `Stop Server` and then `Start Server` once before Task 1.
- Unless a task is explicitly marked as compatibility-only, run it from an interactive `codex` session in the host repo.

## Common Gate Rule

1. Run the current task from interactive `codex` in `/Volumes/Shuttle/unity-projects/neonnew`.
2. Record the exact result summary, including any MCP tool error text.
3. Compare the result with the task's `Expected` section.
4. If the result matches, continue to the next task.
5. If the result does not match, stop immediately and execute **Task 6: Failure Triage And Fix Loop**.
6. After Task 6 finishes, rerun the failed task from its Step 1.
7. If the same task still fails after 3 triage loops, stop the overall run and raise a blocker summary instead of pushing forward.

## Compatibility-Only Codex Exec Template

Use this only when a task explicitly asks for a non-blocking compatibility observation:

```bash
project_dir="/Volumes/Shuttle/unity-projects/neonnew"

codex exec \
  -C "$project_dir" \
  -s danger-full-access \
  --ephemeral \
  -c "projects.\"$project_dir\".trust_level=\"trusted\"" \
  "<task instruction>"
```

### Task 1: Host-Agent Preflight

**Files:**
- Read: `/Volumes/Shuttle/unity-projects/neonnew/.codex/config.toml`
- Read: `/Volumes/Shuttle/unity-projects/neonnew/opencode.json`
- Read: `/Volumes/Shuttle/unity-projects/neonnew/Packages/com.gamelovers.mcp-unity/AGENTS.md`
- Read: `/Volumes/Shuttle/unity-projects/neonnew/ProjectSettings/McpUnitySettings.json`
- Test: `get_scene_info`

**Step 1: Run the Codex preflight**

Interactive `codex` prompt:

```text
Read Packages/com.gamelovers.mcp-unity/AGENTS.md first. Do not modify files. Confirm the mcp-unity server is available in this host project by calling get_scene_info once. Return a short report with: whether MCP Unity tools were available, the active scene name, the loaded scenes list, and whether any transport or tool errors occurred.
```

**Step 2: Evaluate the result**

Expected:
- Codex reports that `mcp-unity` tools are available.
- `get_scene_info` returns an active scene and loaded scene list.
- No transport error, timeout, or `unknown_method` appears.

**Step 3: Continue or branch**

If Expected matches: continue to Task 2.  
If not: jump to Task 6.

### Task 2: Read-Only Smoke Validation

**Files:**
- Read: `/Volumes/Shuttle/unity-projects/neonnew/Packages/com.gamelovers.mcp-unity/AGENTS.md`
- Read: `/Users/nantasmac/Library/Logs/Unity/Editor.log`
- Test: `get_scene_info`
- Test: `get_console_logs`

**Step 1: Run the read-only smoke checks**

Interactive `codex` prompt:

```text
Read Packages/com.gamelovers.mcp-unity/AGENTS.md first. Do not modify files. Use mcp-unity to run these checks in order: 1) call get_scene_info, 2) call get_console_logs with limit=20 and includeStackTrace=false. Return a concise report with the active scene, loaded scenes count, the number of logs returned, and whether either call failed.
```

**Step 2: Evaluate the result**

Expected:
- Both tool calls complete successfully.
- `get_scene_info` returns coherent scene metadata.
- `get_console_logs` returns a non-error payload.
- No disconnect, reconnect storm, or MCP transport failure appears.

**Step 3: Continue or branch**

If Expected matches: continue to Task 3.  
If not: jump to Task 6.

### Task 3: Single-Client Write Smoke Validation

**Files:**
- Read: `/Volumes/Shuttle/unity-projects/neonnew/Packages/com.gamelovers.mcp-unity/AGENTS.md`
- Test: `send_console_log`
- Test: `get_console_logs`

**Step 1: Run a low-risk write operation**

Interactive `codex` prompt:

```text
Read Packages/com.gamelovers.mcp-unity/AGENTS.md first. Do not modify files. Use mcp-unity to send one Unity console log with the exact marker `mcp_smoke_20260310_task3`. Then immediately call get_console_logs with limit=20 and includeStackTrace=false and confirm that the marker appears in the returned logs. Return only the marker match result, the relevant log line, and whether any tool call failed.
```

**Step 2: Evaluate the result**

Expected:
- `send_console_log` succeeds.
- The marker `mcp_smoke_20260310_task3` appears in the follow-up log query.
- No `busy_error` appears in this single-client scenario.

**Step 3: Continue or branch**

If Expected matches: continue to Task 4.  
If not: jump to Task 6.

### Task 4: Targeted EditMode Automation Validation

**Files:**
- Read: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/Tests/McpUnityExecutionGateTests.cs`
- Read: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/Tests/McpUnity.Editor.Tests.asmdef`
- Test: `run_tests`
- Test: `run_tests` with `testFilter=McpUnity.Tests.MaterialToolsTests`

**Step 1: Run the focused MCP Unity EditMode suites**

Interactive `codex` prompt:

```text
Read Packages/com.gamelovers.mcp-unity/AGENTS.md first. Do not modify files. Use mcp-unity run_tests twice in order: 1) testMode=EditMode, testFilter=McpUnity.Tests.McpUnityExecutionGateTests, returnOnlyFailures=false, returnWithLogs=false; 2) testMode=EditMode, testFilter=McpUnity.Tests.MaterialToolsTests, returnOnlyFailures=false, returnWithLogs=false. Return the exact passCount, failCount, skipCount, timedOut flag for each run, and the names of any failed tests.
```

**Step 2: Evaluate the result**

Expected:
- Both `run_tests` calls complete without transport failure in interactive `codex`.
- `McpUnityExecutionGateTests` reports `failCount=0`.
- `MaterialToolsTests` reports `failCount=0` and `timedOut=false`.
- No compile error or assembly reference error appears.

**Step 3: Continue or branch**

If Expected matches: continue to Task 5.  
If not: jump to Task 6.

### Task 5: Multi-Client Write Contention Validation

**Files:**
- Read: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/UnityBridge/McpUnitySocketHandler.cs`
- Read: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/UnityBridge/McpUnityExecutionGate.cs`
- Test: `run_tests`
- Test: `send_console_log`

**Step 1: Start the long-running writer in Terminal A**

Interactive `codex` prompt in Terminal A:

```text
Read Packages/com.gamelovers.mcp-unity/AGENTS.md first. Do not modify files. Use mcp-unity run_tests with testMode=EditMode, empty testFilter, returnOnlyFailures=true, returnWithLogs=false. Return the final passCount, failCount, skipCount, and whether any busy_error or transport error occurred.
```

**Step 2: While Terminal A is still running, start the competing writer in Terminal B**

Interactive `codex` prompt in Terminal B:

```text
Read Packages/com.gamelovers.mcp-unity/AGENTS.md first. Do not modify files. Immediately use mcp-unity to send one Unity console log with marker `mcp_contention_probe_20260310_task5`. Return the raw outcome. If the request fails, include the exact error type and message.
```

**Step 3: Evaluate the combined result**

Expected:
- Terminal A eventually completes its `run_tests` request normally.
- Terminal B receives `busy_error`, not a disconnect and not a silent success during overlap.
- No existing client gets kicked out of the Unity server.

**Step 4: Handle timing misses**

If both Terminal A and Terminal B succeed because they did not overlap long enough:
- rerun Task 5 from Step 1 immediately
- keep Terminal B ready before launching Terminal A
- launch Terminal B as soon as Terminal A starts

**Step 5: Continue or branch**

If Expected matches: continue to Task 7.  
If not: jump to Task 6 for triage/fix, then rerun Task 5.

### Task 6: Failure Triage And Fix Loop

**Files:**
- Read: `/Volumes/Shuttle/unity-projects/neonnew/.codex/config.toml`
- Read: `/Volumes/Shuttle/unity-projects/neonnew/opencode.json`
- Read: `/Volumes/Shuttle/unity-projects/neonnew/ProjectSettings/McpUnitySettings.json`
- Read: `/Users/nantasmac/Library/Logs/Unity/Editor.log`
- Modify: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/UnityBridge/McpUnityServer.cs`
- Modify: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/UnityBridge/McpUnitySocketHandler.cs`
- Modify: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/Tools/RunTestsTool.cs`
- Modify: `/Volumes/Shuttle/unity-projects/mcp-unity/Editor/Tests/McpUnity.Editor.Tests.asmdef`
- Modify: `/Volumes/Shuttle/unity-projects/mcp-unity/Server~/src/index.ts`
- Modify: `/Volumes/Shuttle/unity-projects/mcp-unity/Server~/src/unity/mcpUnity.ts`

**Step 1: Run a root-cause investigation with the failed task context**

Interactive `codex` prompt:

```text
Read Packages/com.gamelovers.mcp-unity/AGENTS.md first. Investigate the failure from <FAILED_TASK_NAME>. The observed output was: <PASTE_EXACT_FAILURE_OUTPUT>. First identify the root cause using host config, Unity logs, and package source. Only after the cause is clear, apply the smallest necessary fix. Then run the narrowest possible verification for that fix and report: root cause, files changed, verification command, verification result, and whether the failure reproduces in interactive codex.
```

**Step 2: Evaluate the triage result**

Expected:
- The report states one explicit root cause.
- Any code or config change is minimal and named with exact file paths.
- A narrow verification was run after the fix.
- The report explicitly states whether the issue reproduces in interactive `codex`, `codex exec`, or both.

**Step 3: Rerun the failed task**

Rerun the failed task from its Step 1.  
Only return to the main flow when the failed task passes.

### Task 7: Final Pass Summary

**Files:**
- Read: `/Volumes/Shuttle/unity-projects/mcp-unity/docs/plans/2026-03-10-neonnew-mcp-validation-plan.md`

**Step 1: Produce the final execution summary**

Interactive `codex` prompt:

```text
Do not modify files. Summarize the finished MCP Unity validation run in five bullets max: Task 1 through Task 5 outcome, any fixes applied in Task 6, whether the package is ready for continued development testing in neonnew, and whether any remaining issue is limited to codex exec compatibility only.
```

**Step 2: Evaluate the result**

Expected:
- The summary covers each gate outcome.
- Any unresolved blocker is stated explicitly.
- If all gates passed in interactive `codex`, the summary says the host-project development workflow is ready for continued testing.
