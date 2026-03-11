# INSTALL-GUIDE

Agent-facing installation guide for installing this fork into a target Unity project without using Unity Package Manager.

This guide is designed so another agent can follow it from a web link and complete the full local install flow inside a Unity project repository.

## Scope

This guide installs `mcp-unity` as a local embedded package at:

```text
<UnityProject>/Packages/com.gamelovers.mcp-unity
```

It does **not** use `Packages/manifest.json` or `Add package from git URL...`.

Default install strategy:

1. clone this repository to a temporary directory
2. build the Node server
3. copy a clean snapshot into the Unity project's `Packages/` folder
4. add the package path to the Unity project's `.gitignore`
5. add local MCP client configuration for one or more of:
   - Claude
   - OpenCode
   - Codex

## Inputs The Agent Must Know

Before starting, collect these values:

- `UNITY_PROJECT_DIR`
  - absolute path to the target Unity project repository
- `CLIENTS_TO_CONFIGURE`
  - one or more of: `claude`, `opencode`, `codex`
- optional `TEMP_CLONE_DIR`
  - if omitted, use a new temp directory

## Preconditions

- `UNITY_PROJECT_DIR` is a real Unity project and already contains a `Packages/` folder
- `node` and `npm` are installed
- the target project path is writable
- the target project can tolerate a local ignored package under `Packages/com.gamelovers.mcp-unity`

## Canonical Install Steps

### Step 1: Clone this repo to a temporary directory

Example:

```bash
TEMP_CLONE_DIR="$(mktemp -d)/mcp-unity"
git clone https://github.com/nantas/mcp-unity.git "$TEMP_CLONE_DIR"
```

If the agent is already operating in a checked-out copy of this repo and the user explicitly wants that checkout, it may skip cloning and use the existing checkout instead. Otherwise prefer a fresh temp clone.

### Step 2: Build the Node server

```bash
cd "$TEMP_CLONE_DIR/Server~"
npm install
npm run build
```

Required artifact:

```text
$TEMP_CLONE_DIR/Server~/build/index.js
```

If that file does not exist after build, stop and report failure.

### Step 3: Copy a clean package snapshot into the Unity project

Target path:

```text
$UNITY_PROJECT_DIR/Packages/com.gamelovers.mcp-unity
```

Recommended copy flow:

```bash
TARGET_PACKAGE_DIR="$UNITY_PROJECT_DIR/Packages/com.gamelovers.mcp-unity"
rm -rf "$TARGET_PACKAGE_DIR"
mkdir -p "$TARGET_PACKAGE_DIR"

rsync -a \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='.DS_Store' \
  --exclude='docs/plans' \
  --exclude='Server~/node_modules' \
  --exclude='Library' \
  --exclude='Temp' \
  --exclude='Logs' \
  --exclude='obj' \
  --exclude='scripts' \
  "$TEMP_CLONE_DIR"/ "$TARGET_PACKAGE_DIR"/
```

After copy, verify:

```text
$UNITY_PROJECT_DIR/Packages/com.gamelovers.mcp-unity/package.json
$UNITY_PROJECT_DIR/Packages/com.gamelovers.mcp-unity/Server~/build/index.js
```

## Step 4: Ensure the Unity repo ignores the embedded package

Add this line to:

```text
$UNITY_PROJECT_DIR/.gitignore
```

```gitignore
/Packages/com.gamelovers.mcp-unity
```

Rules for agents:

- if `.gitignore` does not exist, create it
- if the line already exists, do not duplicate it
- do not remove unrelated ignore rules

## Step 5: Configure local MCP client settings

Use the installed package entrypoint:

```text
$UNITY_PROJECT_DIR/Packages/com.gamelovers.mcp-unity/Server~/build/index.js
```

### Option A: Claude local repo config

Preferred project-local file:

```text
$UNITY_PROJECT_DIR/.mcp.json
```

Expected shape:

```json
{
  "mcpServers": {
    "mcp-unity": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/UNITY_PROJECT/Packages/com.gamelovers.mcp-unity/Server~/build/index.js"
      ]
    }
  }
}
```

Agent merge rules:

- if `.mcp.json` already exists, merge into `mcpServers`
- do not delete existing servers
- if `mcp-unity` already exists, update only that entry

### Option B: OpenCode local repo config

Project-local file:

```text
$UNITY_PROJECT_DIR/opencode.json
```

Expected shape:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-unity": {
      "type": "local",
      "enabled": true,
      "command": [
        "node",
        "/ABSOLUTE/PATH/TO/UNITY_PROJECT/Packages/com.gamelovers.mcp-unity/Server~/build/index.js"
      ]
    }
  }
}
```

Agent merge rules:

- if `opencode.json` already exists, merge into the top-level `mcp` object
- preserve unrelated provider, model, and agent settings
- if `mcp-unity` already exists, update only that entry

### Option C: Codex local repo config

Project-local file:

```text
$UNITY_PROJECT_DIR/.codex/config.toml
```

Expected shape:

```toml
[mcp_servers.mcp-unity]
command = "node"
args = ["/ABSOLUTE/PATH/TO/UNITY_PROJECT/Packages/com.gamelovers.mcp-unity/Server~/build/index.js"]
```

Agent merge rules:

- create `.codex/` if needed
- if `config.toml` already exists, preserve all unrelated sections
- if `[mcp_servers.mcp-unity]` already exists, update only that section

## Step 6: Open Unity and start the MCP server

Inside the Unity Editor:

1. open the target project
2. wait for package import and script compilation
3. open `Tools > MCP Unity > Server Window`
4. confirm the package appears
5. start the server if it is not already running

## Step 7: Validate from the selected client

Minimum validation:

- the MCP client can see the `mcp-unity` server
- a read-only call succeeds

Recommended read-only validation prompt:

```text
Use mcp-unity to call get_scene_info once and summarize the active scene.
```

Recommended write validation prompt:

```text
Use mcp-unity to send one Unity console log with a unique marker, then confirm it appears in get_console_logs.
```

## Expected Final State

After successful installation:

- the Unity project contains:
  - `Packages/com.gamelovers.mcp-unity`
- the Unity project's `.gitignore` contains:
  - `/Packages/com.gamelovers.mcp-unity`
- one or more local client config files point to:
  - `Packages/com.gamelovers.mcp-unity/Server~/build/index.js`
- Unity can start the MCP Unity server
- the configured client can successfully call `get_scene_info`

## Recommended Agent Completion Report

At the end, report:

- target Unity project path
- temp clone path used
- whether Node build succeeded
- whether package snapshot copy succeeded
- whether `.gitignore` was updated
- which client configs were updated
- whether Unity server start was confirmed
- whether `get_scene_info` validation passed

## Notes

- For active package development, a symlink workflow is still better than snapshot copy. See `docs/development-installation.md`.
- For host-project validation, the authoritative workflow is interactive `codex` started inside the Unity project repo.
- `codex exec` may still be used for compatibility checks, but it is not the main validation path for this fork.
