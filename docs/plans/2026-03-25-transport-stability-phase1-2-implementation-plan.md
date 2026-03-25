# Transport Stability Phase 1+2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate frequent transient `Transport closed`/timeout failures by making lifecycle disconnects recoverable and by separating connection timeout from request timeout with sensible defaults.

**Architecture:** Keep the existing Unity single-writer + project-affinity model unchanged, and harden the transport boundary only. Implement lifecycle-aware close semantics (`4001`/`4002`), remove eager pending-request rejection on transient socket errors, and split timeout policy into connect-timeout vs request-timeout with per-tool overrides for known long-running tools.

**Tech Stack:** Unity Editor C# (`WebSocketSharp`), Node.js TypeScript (`ws`, MCP SDK), Jest unit tests.

---

### Task 1: Add failing tests for lifecycle close-code handling in Node transport

**Files:**
- Modify: `Server~/src/__tests__/unityConnection.test.ts`
- Modify: `Server~/src/unity/unityConnection.ts`
- Test: `Server~/src/__tests__/unityConnection.test.ts`

**Step 1: Write the failing test**

```ts
it('recognizes assembly-reload close code (4002) as lifecycle reconnect mode', async () => {
  const connectPromise = connection.connect();
  const wsCtor = (await import('ws')).default as unknown as jest.Mock;
  const socket = wsCtor.mock.results[wsCtor.mock.results.length - 1].value;

  socket.onopen();
  await connectPromise;

  socket.onclose({ code: 4002, reason: 'Unity assembly reload' });

  expect((connection as any).isLifecycleReconnect).toBe(true);
  expect(connection.connectionState).toBe(ConnectionState.Reconnecting);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix Server~ -- unityConnection.test.ts --runInBand`
Expected: FAIL with missing `4002` handling or missing `isLifecycleReconnect` state.

**Step 3: Write minimal implementation**

```ts
export const UnityCloseCode = {
  PLAY_MODE: 4001,
  ASSEMBLY_RELOAD: 4002
} as const;

private isLifecycleReconnect = false;

if (event.code === UnityCloseCode.PLAY_MODE || event.code === UnityCloseCode.ASSEMBLY_RELOAD) {
  this.isLifecycleReconnect = true;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix Server~ -- unityConnection.test.ts --runInBand`
Expected: PASS for the new lifecycle test.

**Step 5: Commit**

```bash
git add Server~/src/__tests__/unityConnection.test.ts Server~/src/unity/unityConnection.ts
git commit -m "test: lock lifecycle reconnect behavior for assembly reload"
```

### Task 2: Fix initial connect Promise settlement on early socket close

**Files:**
- Modify: `Server~/src/__tests__/unityConnection.test.ts`
- Modify: `Server~/src/unity/unityConnection.ts`
- Test: `Server~/src/__tests__/unityConnection.test.ts`

**Step 1: Write the failing test**

```ts
it('rejects connect() when first socket closes before open', async () => {
  const pending = connection.connect();
  const wsCtor = (await import('ws')).default as unknown as jest.Mock;
  const socket = wsCtor.mock.results[wsCtor.mock.results.length - 1].value;

  socket.onclose({ code: 1006, reason: 'Connection refused' });

  await expect(pending).rejects.toMatchObject({ type: ErrorType.CONNECTION });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix Server~ -- unityConnection.test.ts --runInBand`
Expected: FAIL or hang due to unresolved `connect()` Promise.

**Step 3: Write minimal implementation**

```ts
const isInitialConnectAttempt = this.reconnectAttempt === 0;

this.ws.onclose = (event) => {
  // ...existing logic...
  if (isInitialConnectAttempt) {
    reject(new McpUnityError(ErrorType.CONNECTION, reason));
  }
};
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix Server~ -- unityConnection.test.ts --runInBand`
Expected: PASS for new `connect()` reject-path regression.

**Step 5: Commit**

```bash
git add Server~/src/__tests__/unityConnection.test.ts Server~/src/unity/unityConnection.ts
git commit -m "fix: settle initial connect promise on early close"
```

### Task 3: Remove eager pending-request rejection on transient connection error

**Files:**
- Modify: `Server~/src/__tests__/mcpUnity.test.ts`
- Modify: `Server~/src/unity/mcpUnity.ts`
- Test: `Server~/src/__tests__/mcpUnity.test.ts`

**Step 1: Write the failing test**

```ts
it('does not reject all pending requests on transient connection error event', () => {
  const unity = new McpUnity(logger) as any;
  unity.rejectAllPendingRequests = jest.fn();

  unity.handleConnectionError(new McpUnityError(ErrorType.CONNECTION, 'transient socket error'));

  expect(unity.rejectAllPendingRequests).not.toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix Server~ -- mcpUnity.test.ts --runInBand`
Expected: FAIL because `handleConnectionError` does not exist or still rejects pending requests.

**Step 3: Write minimal implementation**

```ts
private handleConnectionError(error: McpUnityError): void {
  this.logger.error(`Connection error: ${error.message}`);
  // Do not reject pending requests here; let state transitions/timeouts decide terminal failure.
}

this.connection.on('error', (error: McpUnityError) => {
  this.handleConnectionError(error);
});
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix Server~ -- mcpUnity.test.ts --runInBand`
Expected: PASS for transient error policy test.

**Step 5: Commit**

```bash
git add Server~/src/__tests__/mcpUnity.test.ts Server~/src/unity/mcpUnity.ts
git commit -m "fix: keep pending requests alive on transient connection errors"
```

### Task 4: Add timeout-policy tests and implement split connect/request timeout defaults

**Files:**
- Modify: `Server~/src/__tests__/mcpUnity.test.ts`
- Modify: `Server~/src/unity/mcpUnity.ts`
- Modify: `Server~/src/unity/unityConnection.ts`
- Test: `Server~/src/__tests__/mcpUnity.test.ts`

**Step 1: Write the failing tests**

```ts
it('uses requestTimeout=60000ms and connectTimeout=10000ms when config is absent', async () => {
  const unity = new McpUnity(logger) as any;
  unity.readConfigFileAsJson = jest.fn().mockResolvedValue({});

  await unity.parseAndSetConfig();

  expect(unity.requestTimeout).toBe(60000);
  expect(unity.connectTimeout).toBe(10000);
});

it('maps RequestTimeoutSeconds from settings to requestTimeout only', async () => {
  const unity = new McpUnity(logger) as any;
  unity.readConfigFileAsJson = jest.fn().mockResolvedValue({ RequestTimeoutSeconds: 90 });

  await unity.parseAndSetConfig();

  expect(unity.requestTimeout).toBe(90000);
  expect(unity.connectTimeout).toBe(10000);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix Server~ -- mcpUnity.test.ts --runInBand`
Expected: FAIL because defaults are still 10s single timeout.

**Step 3: Write minimal implementation**

```ts
private requestTimeout = 60000;
private connectTimeout = 10000;

const configTimeout = config.RequestTimeoutSeconds;
this.requestTimeout = configTimeout ? parseInt(configTimeout, 10) * 1000 : 60000;
this.connectTimeout = 10000;

const config: UnityConnectionConfig = {
  host: this.host,
  port: this.port,
  requestTimeout: this.requestTimeout,
  connectTimeout: this.connectTimeout,
  clientName: this.clientName
};
```

```ts
export interface UnityConnectionConfig {
  host: string;
  port: number;
  requestTimeout: number;
  connectTimeout?: number;
}

const DEFAULT_CONFIG = {
  connectTimeout: 10000,
  // ...existing defaults...
};

// use connect timeout for socket establishment
}, this.config.connectTimeout);
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix Server~ -- mcpUnity.test.ts --runInBand`
Expected: PASS for timeout-default tests.

**Step 5: Commit**

```bash
git add Server~/src/__tests__/mcpUnity.test.ts Server~/src/unity/mcpUnity.ts Server~/src/unity/unityConnection.ts
git commit -m "feat: split connect and request timeouts with safer defaults"
```

### Task 5: Prevent timeout-triggered reconnect storms when already reconnecting/disconnected

**Files:**
- Modify: `Server~/src/__tests__/mcpUnity.test.ts`
- Modify: `Server~/src/unity/mcpUnity.ts`
- Test: `Server~/src/__tests__/mcpUnity.test.ts`

**Step 1: Write the failing tests**

```ts
it('does not call forceReconnect on request timeout when state is reconnecting', async () => {
  jest.useFakeTimers();
  const unity = createConnectedMcpUnity();
  unity.connection.connectionState = ConnectionState.Reconnecting;

  const pending = unity.sendRequestInternal({ id: '1', method: 'x', params: {} }, 10);
  jest.advanceTimersByTime(11);

  await expect(pending).rejects.toMatchObject({ type: ErrorType.TIMEOUT });
  expect(unity.connection.forceReconnect).not.toHaveBeenCalled();
});
```

```ts
it('calls forceReconnect on request timeout only when still connected', async () => {
  jest.useFakeTimers();
  const unity = createConnectedMcpUnity();
  unity.connection.connectionState = ConnectionState.Connected;

  const pending = unity.sendRequestInternal({ id: '2', method: 'y', params: {} }, 10);
  jest.advanceTimersByTime(11);

  await expect(pending).rejects.toMatchObject({ type: ErrorType.TIMEOUT });
  expect(unity.connection.forceReconnect).toHaveBeenCalledTimes(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix Server~ -- mcpUnity.test.ts --runInBand`
Expected: FAIL because timeout path currently always forces reconnect.

**Step 3: Write minimal implementation**

```ts
if (this.connection && this.connectionState === ConnectionState.Connected) {
  this.connection.forceReconnect();
}
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix Server~ -- mcpUnity.test.ts --runInBand`
Expected: PASS for conditional reconnect tests.

**Step 5: Commit**

```bash
git add Server~/src/__tests__/mcpUnity.test.ts Server~/src/unity/mcpUnity.ts
git commit -m "fix: avoid redundant reconnect when request timeout occurs during reconnect"
```

### Task 6: Add per-tool 120s timeout overrides for long-running tools

**Files:**
- Create: `Server~/src/__tests__/longRunningToolTimeouts.test.ts`
- Modify: `Server~/src/tools/runTestsTool.ts`
- Modify: `Server~/src/tools/recompileScriptsTool.ts`
- Modify: `Server~/src/tools/menuItemTool.ts`
- Test: `Server~/src/__tests__/longRunningToolTimeouts.test.ts`

**Step 1: Write the failing test**

```ts
it('run_tests uses 120000ms request timeout override', async () => {
  const handler = getRegisteredHandler('run_tests');
  await handler({ testMode: 'EditMode' });

  expect(mockSendRequest).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'run_tests' }),
    { timeout: 120000 }
  );
});
```

```ts
it('recompile_scripts and execute_menu_item use 120000ms timeout override', async () => {
  await getRegisteredHandler('recompile_scripts')({});
  await getRegisteredHandler('execute_menu_item')({ menuPath: 'Assets/Refresh' });

  expect(mockSendRequest).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ method: 'recompile_scripts' }),
    { timeout: 120000 }
  );
  expect(mockSendRequest).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ method: 'execute_menu_item' }),
    { timeout: 120000 }
  );
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix Server~ -- longRunningToolTimeouts.test.ts --runInBand`
Expected: FAIL because tools currently call `sendRequest` without timeout options.

**Step 3: Write minimal implementation**

```ts
const LONG_RUNNING_TIMEOUT_MS = 120_000;

await mcpUnity.sendRequest(
  {
    method: toolName,
    params: { /* existing params */ }
  },
  { timeout: LONG_RUNNING_TIMEOUT_MS }
);
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix Server~ -- longRunningToolTimeouts.test.ts --runInBand`
Expected: PASS for all three tools.

**Step 5: Commit**

```bash
git add Server~/src/__tests__/longRunningToolTimeouts.test.ts Server~/src/tools/runTestsTool.ts Server~/src/tools/recompileScriptsTool.ts Server~/src/tools/menuItemTool.ts
git commit -m "feat: add long-running timeout overrides for heavy editor tools"
```

### Task 7: Add Unity AssemblyReload close code and wire lifecycle signaling

**Files:**
- Modify: `Editor/UnityBridge/McpUnityServer.cs`
- Test: manual Unity Editor validation

**Step 1: Write the failing validation checklist**

```text
Given Unity connected to MCP
When Assets/Refresh triggers assembly reload
Then Node should log lifecycle reconnect mode (not generic transport failure)
And follow-up read tool should recover without manual MCP restart
```

**Step 2: Run pre-change validation to verify failure/repro**

Run: `Assets/Refresh` (Unity Editor) + a follow-up MCP read call
Expected: generic disconnect classification (no dedicated assembly-reload lifecycle signal).

**Step 3: Write minimal implementation**

```csharp
public const ushort AssemblyReload = 4002;

private static void OnBeforeAssemblyReload()
{
    if (Application.isBatchMode || _instance == null) return;
    if (_instance.IsListening)
    {
        _instance.StopServer(UnityCloseCode.AssemblyReload, "Unity assembly reload");
    }
}
```

**Step 4: Run validation to verify it passes**

Run: same Unity scenario (`Assets/Refresh` + follow-up MCP request)
Expected: reconnect classified as lifecycle transition, follow-up request succeeds after restart.

**Step 5: Commit**

```bash
git add Editor/UnityBridge/McpUnityServer.cs
git commit -m "feat: emit dedicated close code for assembly reload lifecycle"
```

### Task 8: Raise default timeout contract and update docs

**Files:**
- Modify: `Editor/UnityBridge/McpUnitySettings.cs`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README_zh-CN.md`
- Test: `Server~/src/__tests__/mcpUnity.test.ts` + manual config sanity check

**Step 1: Write the failing documentation/config checks**

```text
- Docs still mention implicit 10s default timeout.
- Settings default minimum remains 10 seconds.
```

**Step 2: Run check to verify failure**

Run: `rg -n "10s|10 seconds|RequestTimeoutMinimum" AGENTS.md README.md README_zh-CN.md Editor/UnityBridge/McpUnitySettings.cs`
Expected: matches showing old default guidance/constant.

**Step 3: Write minimal implementation**

```csharp
public const int RequestTimeoutMinimum = 60;
public int RequestTimeoutSeconds = RequestTimeoutMinimum;
```

Update docs to state:
- default request timeout is 60s
- long-running tools may use 120s per-request override
- assembly reload / play mode disconnects are expected lifecycle events
- `busy_error` is business-level backpressure, not transport corruption

**Step 4: Run verification**

Run: `npm test --prefix Server~ -- --runInBand`
Expected: PASS (all tests green).

Run (Unity manual): open MCP settings UI and confirm default timeout displays 60 seconds.
Expected: value reflects new default.

**Step 5: Commit**

```bash
git add Editor/UnityBridge/McpUnitySettings.cs AGENTS.md README.md README_zh-CN.md
git commit -m "docs: update timeout and lifecycle recovery guidance"
```

### Task 9: Full regression verification and release-ready diff review

**Files:**
- Modify: none (verification only)
- Test: Node automated tests + Unity manual matrix

**Step 1: Run full Node test suite**

Run: `npm test --prefix Server~ -- --runInBand`
Expected: PASS all suites.

**Step 2: Run Node build**

Run: `npm run build --prefix Server~`
Expected: TypeScript build success with no compile errors.

**Step 3: Run Unity manual matrix**

```text
- Scenario A: Assembly reload reconnect
- Scenario B: Play mode reconnect
- Scenario C: run_tests >10s not false-timeout
- Scenario D: overlapping writes returns busy_error without reconnect storm
```

Expected: all scenarios meet design acceptance criteria.

**Step 4: Capture release notes summary in commit body or PR description**

```text
- lifecycle close code 4002 introduced
- pending-request failure boundary tightened
- timeout split + defaults updated
- long-running tool timeout overrides added
```

**Step 5: Commit (if verification-only changes exist)**

```bash
git status
# If no file changes: no commit required
# If verification artifacts were added intentionally:
git add <artifact-paths>
git commit -m "chore: add transport stability verification artifacts"
```

---

## Implementation Notes

- Follow @superpowers:test-driven-development for each code task.
- Use @superpowers:verification-before-completion before claiming stability fixes complete.
- Keep commits small and reversible; one task should map to one commit.
- Do not batch Unity C# changes and Node transport changes into one large commit.
