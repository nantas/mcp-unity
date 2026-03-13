# Project Path Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce strict project-path affinity for all MCP Unity requests so tools/resources cannot execute against the wrong Unity project.

**Architecture:** Add a connection-level handshake (`mcp_unity_handshake`) that validates Unity project root against agent workspace root, then gate all request forwarding on handshake success. Re-run handshake on reconnect before command replay.

**Tech Stack:** TypeScript (Node MCP server), C# (Unity Editor WebSocket handler), Jest tests, Unity EditMode tests.

---

### Task 1: Define Shared Error Contract

**Files:**
- Modify: `Server~/src/utils/errors.ts`
- Modify: `Server~/src/unity/mcpUnity.ts`

**Step 1: Write the failing test**

- Add a Node test that expects mismatch handshake errors to map to a dedicated error type.

**Step 2: Run test to verify it fails**

Run: `cd Server~ && npm test -- mcpUnity.test.ts --runInBand`
Expected: FAIL because `project_mismatch_error` is not recognized.

**Step 3: Write minimal implementation**

- Add `PROJECT_MISMATCH = 'project_mismatch_error'` to `ErrorType`.
- Ensure Unity response error mapping preserves that type.

**Step 4: Run test to verify it passes**

Run: `cd Server~ && npm test -- mcpUnity.test.ts --runInBand`
Expected: PASS.

**Step 5: Commit**

```bash
git add Server~/src/utils/errors.ts Server~/src/unity/mcpUnity.ts Server~/src/__tests__/mcpUnity.test.ts
git commit -m "feat: add project mismatch error contract"
```

### Task 2: Add Node Workspace Path Resolution And Normalization

**Files:**
- Modify: `Server~/src/unity/mcpUnity.ts`
- Test: `Server~/src/__tests__/mcpUnity.test.ts`

**Step 1: Write the failing test**

- Add tests for expected workspace root resolution order:
  - `MCP_UNITY_WORKSPACE_ROOT` wins.
  - fallback to `process.cwd()`.
- Add tests for normalization behavior (trailing slash, separator normalization).

**Step 2: Run test to verify it fails**

Run: `cd Server~ && npm test -- mcpUnity.test.ts --runInBand`
Expected: FAIL due to missing resolver/normalizer APIs.

**Step 3: Write minimal implementation**

- Add helper methods in `McpUnity`:
  - `resolveExpectedWorkspaceRoot()`
  - `normalizeProjectPath(path: string)`

**Step 4: Run test to verify it passes**

Run: `cd Server~ && npm test -- mcpUnity.test.ts --runInBand`
Expected: PASS.

**Step 5: Commit**

```bash
git add Server~/src/unity/mcpUnity.ts Server~/src/__tests__/mcpUnity.test.ts
git commit -m "feat: resolve and normalize expected workspace root"
```

### Task 3: Add Unity Handshake Endpoint

**Files:**
- Modify: `Editor/UnityBridge/McpUnitySocketHandler.cs`
- Test: `Editor/Tests/` (new or existing Unity EditMode test file for socket handler/path comparison)

**Step 1: Write the failing test**

- Add tests covering:
  - handshake success when paths match.
  - `project_mismatch_error` when mismatch.
  - normalized comparison behavior.

**Step 2: Run test to verify it fails**

Run (example):
`"$UNITY_BIN" -batchmode -projectPath /Volumes/Shuttle/unity-projects/mcp-unity -runTests -testPlatform EditMode -testFilter McpUnity.Tests.<HandshakeTestClass> -quit`
Expected: FAIL because `mcp_unity_handshake` is unknown.

**Step 3: Write minimal implementation**

- Intercept `method == "mcp_unity_handshake"` before tool/resource lookup.
- Compute current Unity project root from `Application.dataPath` parent.
- Normalize compare with request path.
- Return success result or error response with expected/actual details.

**Step 4: Run test to verify it passes**

Run same Unity EditMode test command.
Expected: PASS.

**Step 5: Commit**

```bash
git add Editor/UnityBridge/McpUnitySocketHandler.cs Editor/Tests
git commit -m "feat: add unity handshake for project path validation"
```

### Task 4: Enforce Handshake Gate In Node Request Flow

**Files:**
- Modify: `Server~/src/unity/mcpUnity.ts`
- Test: `Server~/src/__tests__/mcpUnity.test.ts`

**Step 1: Write the failing test**

- Add tests:
  - `start()` triggers handshake.
  - non-handshake `sendRequest()` blocked if not validated.
  - reconnect clears validation and re-validates before replay.

**Step 2: Run test to verify it fails**

Run: `cd Server~ && npm test -- mcpUnity.test.ts unityConnection.test.ts --runInBand`
Expected: FAIL for missing gate behavior.

**Step 3: Write minimal implementation**

- Add state fields (`handshakeValidated`, etc.).
- Add `validateProjectAffinity()` call on connect/reconnect.
- In `sendRequest()`, reject all methods except `mcp_unity_handshake` until validated.

**Step 4: Run test to verify it passes**

Run: `cd Server~ && npm test -- mcpUnity.test.ts unityConnection.test.ts --runInBand`
Expected: PASS.

**Step 5: Commit**

```bash
git add Server~/src/unity/mcpUnity.ts Server~/src/__tests__/mcpUnity.test.ts Server~/src/__tests__/unityConnection.test.ts
git commit -m "feat: enforce project affinity handshake gate"
```

### Task 5: Wire Error Handling And User-Facing Diagnostics

**Files:**
- Modify: `Server~/src/tools/*.ts` (only if needed for improved diagnostics)
- Modify: `Server~/src/unity/mcpUnity.ts`
- Test: `Server~/src/__tests__/mcpUnity.test.ts`

**Step 1: Write the failing test**

- Assert mismatch error surfaces path details to caller in predictable structure.

**Step 2: Run test to verify it fails**

Run: `cd Server~ && npm test -- mcpUnity.test.ts --runInBand`
Expected: FAIL.

**Step 3: Write minimal implementation**

- Ensure mismatch error keeps details fields and does not trigger forced reconnect logic.

**Step 4: Run test to verify it passes**

Run: `cd Server~ && npm test -- mcpUnity.test.ts --runInBand`
Expected: PASS.

**Step 5: Commit**

```bash
git add Server~/src/unity/mcpUnity.ts Server~/src/__tests__/mcpUnity.test.ts
git commit -m "fix: surface project mismatch diagnostics without reconnect churn"
```

### Task 6: Documentation Updates

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README_zh-CN.md`
- Modify: `README-ja.md`

**Step 1: Write doc assertions checklist**

- Add explicit invariant: all tools/resources require project-path handshake match.
- Add env var docs for `MCP_UNITY_WORKSPACE_ROOT` and compatibility behavior.

**Step 2: Verify docs contain new contract**

Run:
`rg -n "project_mismatch_error|mcp_unity_handshake|MCP_UNITY_WORKSPACE_ROOT|project-path" AGENTS.md README.md README_zh-CN.md README-ja.md`
Expected: matches in all relevant docs.

**Step 3: Commit**

```bash
git add AGENTS.md README.md README_zh-CN.md README-ja.md
git commit -m "docs: document strict project path validation handshake"
```

### Task 7: End-to-End Validation

**Files:**
- Read: `ProjectSettings/McpUnitySettings.json` (host project)
- Test: MCP tools (`get_scene_info`, `run_tests`, `send_console_log`)

**Step 1: Match scenario validation**

- Start MCP from same repo as Unity project.
- Call read tool + write tool + `run_tests`.
- Expect all succeed.

**Step 2: Mismatch scenario validation**

- Keep Unity project A open.
- Start MCP from repo B pointing to A endpoint.
- Call read and write tools, plus `run_tests`.
- Expect all fail fast with `project_mismatch_error`.

**Step 3: Reconnect scenario validation**

- Trigger Unity domain reload or server restart.
- Verify reconnect performs handshake before queued request replay.

**Step 4: Record evidence and finalize**

- Capture key outputs: error type, expectedPath, actualPath.
- Confirm no accidental cross-repo execution observed.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-13-project-path-validation-design.md docs/plans/2026-03-13-project-path-validation-implementation-plan.md
git commit -m "chore: add project path validation design and implementation plan"
```
