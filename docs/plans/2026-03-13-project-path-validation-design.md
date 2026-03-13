# MCP Unity Project Path Validation Design

## Context

Current `mcp-unity` tool execution is bound only by WebSocket endpoint (`host:port`), not by project identity. If multiple Unity editors exist and one editor is listening on the expected endpoint, Node can route all tools (including `run_tests`) into the wrong project, causing cross-repo execution.

## Goal

Enforce project affinity for **all tools/resources**: Unity server project root must match MCP agent workspace root before any request is executed.

## Non-Goals

- Do not redesign tool registration and naming.
- Do not special-case `run_tests`; policy must apply globally.
- Do not require per-tool schema changes for workspace path parameters.

## Requirements

- Enforce validation once connection is established and block all business requests until validated.
- Return deterministic mismatch errors with expected/actual paths.
- Re-validate after reconnect.
- Preserve compatibility for existing tool/resource method strings.

## Proposed Architecture (Recommended)

### 1) Add explicit handshake method

Add a Unity built-in protocol method: `mcp_unity_handshake` handled by `McpUnitySocketHandler` before tool/resource dispatch.

Request payload:
- `expectedWorkspacePath`: string (agent workspace root)

Response payload:
- `success`: bool
- `unityProjectPath`: normalized Unity project root
- `matched`: bool
- `message`: string

On mismatch, return JSON-RPC error:
- `type: "project_mismatch_error"`
- `message`: concise mismatch reason
- `details.expectedPath`
- `details.actualPath`

### 2) Enforce gate in Node transport layer

`McpUnity` keeps a connection-level validation state:
- `handshakeValidated: boolean`
- `lastValidatedWorkspacePath: string`

Flow:
1. `start()` connects transport.
2. Immediately call `validateProjectAffinity()` (handshake).
3. `sendRequest()` rejects all non-handshake methods when not validated.
4. On reconnect (`Connected` transition), handshake runs again before replaying queued commands.

### 3) Workspace root source of truth

Node expected workspace path resolution order:
1. `MCP_UNITY_WORKSPACE_ROOT` env var (explicit override)
2. `process.cwd()` (default)

This avoids hidden coupling to package installation paths and matches agent working-directory semantics.

### 4) Canonical path normalization

Implement normalization on both sides before compare:
- absolute full path
- resolve symbolic links when possible
- normalize path separators
- trim trailing separators
- Windows: case-insensitive compare

## Alternative Approaches Considered

1. Port-only isolation (different project, different port)
- Rejected: configuration drift and no hard safety guarantee.

2. Add workspace path to every tool/resource request
- Rejected: broad schema churn and larger backward-compat burden.

3. Handshake + transport gate (chosen)
- Selected for strong guarantee with minimal business-surface changes.

## Error Model

Add new error type (Node + Unity contract):
- `project_mismatch_error`

Behavior:
- Treated as business-level validation failure, not reconnect trigger.
- Message should include both paths in details; avoid noisy stack traces.

## Compatibility Strategy

- Existing tools/resources unchanged.
- Existing method names unchanged.
- Only transport precondition changes: requests fail fast if project mismatch.
- Optional temporary escape hatch (migration only): `MCP_UNITY_ALLOW_UNVERIFIED=true` (default false).

## Security / Safety Notes

- This prevents accidental cross-repo writes/tests when multiple editors are open.
- It does not authenticate remote machines; network trust remains unchanged.

## Test Strategy

### Node tests

- handshake success marks connection validated.
- handshake mismatch yields `project_mismatch_error` and blocks tool requests.
- reconnect clears validation and requires re-handshake.
- command replay occurs only after successful re-validation.

### Unity tests

- path normalization/compare behavior (separator, trailing slash, case sensitivity).
- handshake response content on match/mismatch.

### Manual E2E

- Start Unity A (project X) + Unity B (project Y).
- Run MCP from workspace X while endpoint points to Y.
- Verify every tool fails fast with mismatch error (including `run_tests`, read resources, write tools).

## Rollout

1. Implement handshake in Unity and Node.
2. Add tests and docs (`AGENTS.md`, `README*`).
3. Validate against dual-editor setup.
4. Enable strict mode by default.
