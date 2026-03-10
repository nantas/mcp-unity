# Multi-Client Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow multiple Node/MCP clients to stay connected to one Unity Editor without kicking each other, while enforcing single-writer admission and returning explicit `busy` errors for conflicting write requests.

**Architecture:** Keep phase 1 intentionally small. Unity becomes the authority for connection coexistence and single-writer admission. Tools/resources declare an execution kind so the WebSocket handler can allow reads through, reject conflicting writes immediately, and preserve the current synchronous request/response contract.

**Tech Stack:** Unity Editor C#, websocket-sharp, Newtonsoft Json, Unity EditMode tests, TypeScript, Jest, MCP SDK

---

### Task 1: Add Node-side busy error typing

**Files:**
- Modify: `Server~/src/utils/errors.ts`
- Modify: `Server~/src/__tests__/errors.test.ts`

**Step 1: Write the failing test**

Add a Jest assertion that proves `busy_error` is a first-class error type instead of being lumped into generic tool execution failures.

```ts
it('includes busy_error in ErrorType', () => {
  expect(ErrorType.BUSY).toBe('busy_error');
});

it('serializes busy errors without losing details', () => {
  const error = new McpUnityError(ErrorType.BUSY, 'Writer is busy', {
    retryable: true,
    activeOperation: 'update_gameobject'
  });

  expect(error.toJSON()).toEqual({
    type: ErrorType.BUSY,
    message: 'Writer is busy',
    details: {
      retryable: true,
      activeOperation: 'update_gameobject'
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/Shuttle/unity-projects/mcp-unity/Server~
npm test -- --runTestsByPath src/__tests__/errors.test.ts
```

Expected: FAIL because `ErrorType.BUSY` does not exist yet.

**Step 3: Write minimal implementation**

Update the enum in `Server~/src/utils/errors.ts`.

```ts
export enum ErrorType {
  CONNECTION = 'connection_error',
  TOOL_EXECUTION = 'tool_execution_error',
  RESOURCE_FETCH = 'resource_fetch_error',
  VALIDATION = 'validation_error',
  INTERNAL = 'internal_error',
  TIMEOUT = 'timeout_error',
  BUSY = 'busy_error'
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd /Volumes/Shuttle/unity-projects/mcp-unity/Server~
npm test -- --runTestsByPath src/__tests__/errors.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add Server~/src/utils/errors.ts Server~/src/__tests__/errors.test.ts
git commit -m "test: add busy error type coverage"
```

### Task 2: Add Unity operation kind metadata and a single-writer gate

**Files:**
- Create: `Editor/UnityBridge/McpOperationKind.cs`
- Create: `Editor/UnityBridge/McpUnityExecutionGate.cs`
- Create: `Editor/Tests/McpOperationKindTests.cs`
- Create: `Editor/Tests/McpUnityExecutionGateTests.cs`
- Modify: `Editor/Tools/McpToolBase.cs`
- Modify: `Editor/Resources/McpResourceBase.cs`

**Step 1: Write the failing tests**

Add EditMode tests for the defaults and the gate behavior.

```csharp
[Test]
public void ToolBase_DefaultsToWrite()
{
    var tool = new FakeTool();
    Assert.AreEqual(McpOperationKind.Write, tool.OperationKind);
}

[Test]
public void ResourceBase_DefaultsToRead()
{
    var resource = new FakeResource();
    Assert.AreEqual(McpOperationKind.Read, resource.OperationKind);
}

[Test]
public void TryEnterWrite_FailsWhenAnotherWriteIsActive()
{
    var gate = new McpUnityExecutionGate();

    Assert.IsTrue(gate.TryEnterWrite("session-a", "client-a", "update_gameobject"));
    Assert.IsFalse(gate.TryEnterWrite("session-b", "client-b", "save_scene"));
}

[Test]
public void ExitWrite_ReleasesTheGate()
{
    var gate = new McpUnityExecutionGate();

    Assert.IsTrue(gate.TryEnterWrite("session-a", "client-a", "update_gameobject"));
    gate.ExitWrite("session-a");

    Assert.IsTrue(gate.TryEnterWrite("session-b", "client-b", "save_scene"));
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
export UNITY_BIN="<path-to-your-Unity-2022.3-editor>"
"$UNITY_BIN" -batchmode -projectPath /Volumes/Shuttle/unity-projects/mcp-unity -runTests -testPlatform EditMode -testFilter McpOperationKindTests -testResults /tmp/mcp-unity-editmode.xml -quit
"$UNITY_BIN" -batchmode -projectPath /Volumes/Shuttle/unity-projects/mcp-unity -runTests -testPlatform EditMode -testFilter McpUnityExecutionGateTests -testResults /tmp/mcp-unity-editmode.xml -quit
```

Expected: FAIL because the enum, gate, and `OperationKind` properties do not exist.

**Step 3: Write minimal implementation**

Create the enum and gate, then add defaults to the base types.

```csharp
public enum McpOperationKind
{
    Read,
    Write,
    CompositeWrite
}
```

```csharp
public sealed class McpUnityExecutionGate
{
    private readonly object _sync = new object();
    private string _activeSessionId;
    private string _activeClientName;
    private string _activeOperation;

    public bool TryEnterWrite(string sessionId, string clientName, string operationName)
    {
        lock (_sync)
        {
            if (!string.IsNullOrEmpty(_activeSessionId))
            {
                return false;
            }

            _activeSessionId = sessionId;
            _activeClientName = clientName;
            _activeOperation = operationName;
            return true;
        }
    }

    public void ExitWrite(string sessionId)
    {
        lock (_sync)
        {
            if (_activeSessionId == sessionId)
            {
                _activeSessionId = null;
                _activeClientName = null;
                _activeOperation = null;
            }
        }
    }
}
```

Also add the default property to the base classes:

```csharp
public McpOperationKind OperationKind { get; protected set; } = McpOperationKind.Write;
```

```csharp
public McpOperationKind OperationKind { get; protected set; } = McpOperationKind.Read;
```

**Step 4: Run test to verify it passes**

Run the same two EditMode test commands from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add Editor/UnityBridge/McpOperationKind.cs Editor/UnityBridge/McpUnityExecutionGate.cs Editor/Tools/McpToolBase.cs Editor/Resources/McpResourceBase.cs Editor/Tests/McpOperationKindTests.cs Editor/Tests/McpUnityExecutionGateTests.cs
git commit -m "feat: add operation kinds and writer gate"
```

### Task 3: Classify read tools and composite writes explicitly

**Files:**
- Modify: `Editor/Tools/GetGameObjectTool.cs`
- Modify: `Editor/Tools/GetSceneInfoTool.cs`
- Modify: `Editor/Tools/BatchExecuteTool.cs`
- Modify: `Editor/Resources/McpResourceBase.cs`
- Modify: `Editor/Tests/McpOperationKindTests.cs`

**Step 1: Write the failing test**

Extend `Editor/Tests/McpOperationKindTests.cs` to verify the agreed phase-1 classification.

```csharp
[Test]
public void GetGameObjectTool_IsRead()
{
    Assert.AreEqual(McpOperationKind.Read, new GetGameObjectTool().OperationKind);
}

[Test]
public void GetSceneInfoTool_IsRead()
{
    Assert.AreEqual(McpOperationKind.Read, new GetSceneInfoTool().OperationKind);
}

[Test]
public void BatchExecuteTool_IsCompositeWrite()
{
    var server = Substitute.For<McpUnityServer>();
    Assert.AreEqual(McpOperationKind.CompositeWrite, new BatchExecuteTool(server).OperationKind);
}
```

If you do not want to pull in a mocking library for the test, add a minimal constructor overload or helper to avoid needing a real `McpUnityServer`.

**Step 2: Run test to verify it fails**

Run:

```bash
export UNITY_BIN="<path-to-your-Unity-2022.3-editor>"
"$UNITY_BIN" -batchmode -projectPath /Volumes/Shuttle/unity-projects/mcp-unity -runTests -testPlatform EditMode -testFilter McpOperationKindTests -testResults /tmp/mcp-unity-editmode.xml -quit
```

Expected: FAIL because the concrete tools still use the default kind.

**Step 3: Write minimal implementation**

Set the agreed execution kinds in the tool constructors.

```csharp
public GetGameObjectTool()
{
    Name = "get_gameobject";
    OperationKind = McpOperationKind.Read;
}
```

```csharp
public GetSceneInfoTool()
{
    Name = "get_scene_info";
    OperationKind = McpOperationKind.Read;
}
```

```csharp
public BatchExecuteTool(McpUnityServer server)
{
    _server = server;
    Name = "batch_execute";
    IsAsync = true;
    OperationKind = McpOperationKind.CompositeWrite;
}
```

**Step 4: Run test to verify it passes**

Run the EditMode test command from Step 2 again.

Expected: PASS.

**Step 5: Commit**

```bash
git add Editor/Tools/GetGameObjectTool.cs Editor/Tools/GetSceneInfoTool.cs Editor/Tools/BatchExecuteTool.cs Editor/Tests/McpOperationKindTests.cs
git commit -m "feat: classify read and composite write operations"
```

### Task 4: Enforce single-writer admission in the Unity socket handler

**Files:**
- Modify: `Editor/UnityBridge/McpUnityServer.cs`
- Modify: `Editor/UnityBridge/McpUnitySocketHandler.cs`
- Modify: `Editor/Tests/McpUnityExecutionGateTests.cs`

**Step 1: Write the failing test**

Add coverage for the admission rules around the gate helper and the busy response shape.

```csharp
[Test]
public void CreateBusyResponse_UsesBusyErrorType()
{
    var response = McpUnitySocketHandler.CreateBusyResponse("update_gameobject", "Client A");

    Assert.AreEqual("busy_error", response["error"]?["type"]?.ToString());
    Assert.That(response["error"]?["message"]?.ToString(), Does.Contain("update_gameobject"));
}

[Test]
public void ActiveWriterMetadata_IsAvailableForBusyResponses()
{
    var gate = new McpUnityExecutionGate();
    gate.TryEnterWrite("session-a", "Client A", "save_scene");

    Assert.AreEqual("save_scene", gate.ActiveOperation);
    Assert.AreEqual("Client A", gate.ActiveClientName);
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
export UNITY_BIN="<path-to-your-Unity-2022.3-editor>"
"$UNITY_BIN" -batchmode -projectPath /Volumes/Shuttle/unity-projects/mcp-unity -runTests -testPlatform EditMode -testFilter McpUnityExecutionGateTests -testResults /tmp/mcp-unity-editmode.xml -quit
```

Expected: FAIL because the busy helper and metadata accessors do not exist.

**Step 3: Write minimal implementation**

1. Add one shared gate instance to `McpUnityServer`.
2. Remove the stale-session closing loop from `McpUnitySocketHandler.OnOpen()`.
3. Before executing a `Write` or `CompositeWrite` request:
   - fetch the client name from `_server.Clients`
   - try to enter the gate
   - if the gate is busy, return a JSON error immediately
4. Release the gate in a `finally` path after `await tcs.Task`

Core handler shape:

```csharp
var operationKind = ResolveOperationKind(method, tool, resource);
var hasWriteLease = false;

if (operationKind != McpOperationKind.Read)
{
    if (!_server.ExecutionGate.TryEnterWrite(ID, clientName, method))
    {
        Send(CreateResponse(requestId, CreateBusyResponse(
            _server.ExecutionGate.ActiveOperation,
            _server.ExecutionGate.ActiveClientName
        )).ToString(Formatting.None));
        return;
    }

    hasWriteLease = true;
}

try
{
    JObject responseJson = await tcs.Task;
    Send(CreateResponse(requestId, responseJson).ToString(Formatting.None));
}
finally
{
    if (hasWriteLease)
    {
        _server.ExecutionGate.ExitWrite(ID);
    }
}
```

Keep the read path untouched apart from routing through the shared helper.

**Step 4: Run test to verify it passes**

Run the EditMode test command from Step 2 again.

Expected: PASS.

**Step 5: Commit**

```bash
git add Editor/UnityBridge/McpUnityServer.cs Editor/UnityBridge/McpUnitySocketHandler.cs Editor/Tests/McpUnityExecutionGateTests.cs
git commit -m "feat: allow multi-client connections with single-writer admission"
```

### Task 5: Surface busy responses correctly in the Node bridge

**Files:**
- Modify: `Server~/src/unity/mcpUnity.ts`
- Modify: `Server~/src/__tests__/mcpUnity.test.ts`
- Modify: `Server~/src/__tests__/errors.test.ts`

**Step 1: Write the failing test**

Add a focused test that proves `busy_error` becomes `ErrorType.BUSY` and does not trigger reconnect-side behavior.

```ts
it('maps busy_error responses to ErrorType.BUSY', () => {
  const error = mapUnityResponseError({
    type: 'busy_error',
    message: 'Another write operation is already in progress',
    details: { retryable: true }
  });

  expect(error.type).toBe(ErrorType.BUSY);
  expect(error.details).toEqual({ retryable: true });
});
```

If the existing class structure makes this difficult to test directly, extract a small helper such as `mapUnityResponseError()` from `handleMessage()` and test that helper in isolation.

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/Shuttle/unity-projects/mcp-unity/Server~
npm test -- --runTestsByPath src/__tests__/mcpUnity.test.ts src/__tests__/errors.test.ts
```

Expected: FAIL because `busy_error` is still treated as a generic tool execution error.

**Step 3: Write minimal implementation**

Map Unity error types explicitly in `handleMessage()`.

```ts
function mapUnityResponseError(error: UnityResponse['error']): McpUnityError {
  if (error?.type === 'busy_error') {
    return new McpUnityError(ErrorType.BUSY, error.message || 'Unity writer is busy', error.details);
  }

  return new McpUnityError(
    ErrorType.TOOL_EXECUTION,
    error?.message || 'Unknown error',
    error?.details
  );
}
```

Then use it here:

```ts
if (response.error) {
  request.reject(mapUnityResponseError(response.error));
} else {
  request.resolve(response.result);
}
```

Do not add reconnect logic anywhere in this path.

**Step 4: Run test to verify it passes**

Run:

```bash
cd /Volumes/Shuttle/unity-projects/mcp-unity/Server~
npm test -- --runTestsByPath src/__tests__/mcpUnity.test.ts src/__tests__/errors.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add Server~/src/unity/mcpUnity.ts Server~/src/__tests__/mcpUnity.test.ts Server~/src/__tests__/errors.test.ts
git commit -m "feat: surface busy unity responses without reconnecting"
```

### Task 6: Update high-signal docs and run acceptance verification

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README_zh-CN.md`

**Step 1: Write the doc updates**

Update the docs to reflect the new invariants:

- multiple clients may stay connected simultaneously
- phase-1 write conflicts return `busy_error`
- single-writer admission exists on the Unity side
- `busy_error` is a normal business response, not a transport failure

Recommended AGENTS.md additions:

```md
- **Connection policy**: multiple WebSocket clients may coexist; Unity no longer kicks the previous client on connect.
- **Execution policy**: phase 1 is single-writer admission only. Read requests pass through; conflicting write requests return `busy_error`.
- **Error boundary**: `busy_error` is a normal request response and must not trigger Node reconnect logic.
```

**Step 2: Run automated verification**

Run:

```bash
export UNITY_BIN="<path-to-your-Unity-2022.3-editor>"
cd /Volumes/Shuttle/unity-projects/mcp-unity/Server~
npm test
npm run build
"$UNITY_BIN" -batchmode -projectPath /Volumes/Shuttle/unity-projects/mcp-unity -runTests -testPlatform EditMode -testResults /tmp/mcp-unity-editmode.xml -quit
```

Expected:

- Jest suite passes
- TypeScript build succeeds
- Unity EditMode tests pass

**Step 3: Run manual multi-client acceptance check**

1. Open the Unity project and confirm the server is listening on port `8090`.
2. Start one MCP client session and send a write request such as `update_gameobject`.
3. Start a second MCP client session while the first remains connected.
4. Confirm the second session does not disconnect the first.
5. Trigger overlapping write requests from both sessions.
6. Confirm one request runs and the other receives `busy_error`.
7. Trigger a read request such as `get_scene_info` from the idle session and confirm it still returns a normal response.
8. Inspect Unity Console and confirm the conflict is logged as warning/info rather than a transport error.

**Step 4: Commit**

```bash
git add AGENTS.md README.md README_zh-CN.md
git commit -m "docs: document multi-client single-writer behavior"
```

**Step 5: Final verification note**

Record the exact evidence in the implementation PR or handoff note:

- Jest command output summary
- `npm run build` result
- Unity EditMode test result path
- manual multi-client acceptance observations

