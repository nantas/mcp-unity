import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Logger, LogLevel } from '../utils/logger.js';
import { McpUnityError, ErrorType } from '../utils/errors.js';
import { registerTransformTools } from '../tools/transformTools.js';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { mapUnityResponseError, resolveMcpUnitySettingsPath } from '../unity/mcpUnity.js';
import { normalizeWorkspacePath, pathsMatch, resolveExpectedWorkspaceRoot } from '../unity/mcpUnity.js';
import { McpUnity, ConnectionState } from '../unity/mcpUnity.js';

describe('McpUnityError integration', () => {
  it('should create proper error for connection issues', () => {
    const error = new McpUnityError(ErrorType.CONNECTION, 'Failed to connect to Unity');

    expect(error.type).toBe('connection_error');
    expect(error.message).toBe('Failed to connect to Unity');
  });

  it('should create proper error for timeout', () => {
    const error = new McpUnityError(ErrorType.TIMEOUT, 'Request timed out');

    expect(error.type).toBe('timeout_error');
  });

  it('maps busy_error responses to ErrorType.BUSY', () => {
    const error = mapUnityResponseError({
      type: 'busy_error',
      message: 'Another write operation is already in progress',
      details: { retryable: true, activeOperation: 'update_gameobject' }
    });

    expect(error.type).toBe(ErrorType.BUSY);
    expect(error.message).toBe('Another write operation is already in progress');
    expect(error.details).toEqual({
      retryable: true,
      activeOperation: 'update_gameobject'
    });
  });

  it('maps project_mismatch_error responses to ErrorType.PROJECT_MISMATCH', () => {
    const error = mapUnityResponseError({
      type: 'project_mismatch_error',
      message: 'Workspace does not match Unity project',
      details: {
        expectedPath: '/repo/a',
        actualPath: '/repo/b'
      }
    });

    expect(error.type).toBe(ErrorType.PROJECT_MISMATCH);
    expect(error.message).toBe('Workspace does not match Unity project');
    expect(error.details).toEqual({
      expectedPath: '/repo/a',
      actualPath: '/repo/b'
    });
  });
});

describe('Path handling in configuration', () => {
  it('should handle paths with spaces in config file path', () => {
    // The config path uses path.resolve which handles spaces correctly
    const pathWithSpaces = '/Users/John Doe/My Project/ProjectSettings/McpUnitySettings.json';

    // Verify path module handles spaces
    const resolved = path.resolve(pathWithSpaces);

    expect(resolved).toContain('John Doe');
    expect(resolved).toContain('My Project');
  });

  it('should handle Windows-style paths with spaces', () => {
    const windowsPath = 'C:\\Users\\John Doe\\My Project\\ProjectSettings';

    // path.normalize handles both styles
    const normalized = path.normalize(windowsPath);

    expect(normalized).toContain('John Doe');
  });

  it('should properly construct WebSocket URL', () => {
    // WebSocket URLs don't need special encoding for host/port
    const host = 'localhost';
    const port = 8090;
    const wsUrl = `ws://${host}:${port}/McpUnity`;

    expect(wsUrl).toBe('ws://localhost:8090/McpUnity');
  });

  it('should handle path.join with spaces', () => {
    const basePath = '/Users/John Doe/Projects';
    const subPath = 'My Unity Game';
    const fileName = 'settings.json';

    const fullPath = path.join(basePath, subPath, fileName);

    expect(fullPath).toContain('John Doe');
    expect(fullPath).toContain('My Unity Game');
    expect(fullPath).toContain('settings.json');
  });

  it('should handle path.resolve with relative paths containing spaces', () => {
    const cwd = '/Users/Test User/Current Dir';
    const relativePath = '../Other Project/file.txt';

    // path.resolve will work correctly with spaces
    const resolved = path.resolve(cwd, relativePath);

    expect(resolved).toContain('Test User');
  });

  it('finds host ProjectSettings from an installed package module path when cwd is elsewhere', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-unity-config-'));
    const hostRoot = path.join(tempRoot, 'Host Project');
    const moduleDir = path.join(
      hostRoot,
      'Packages',
      'com.gamelovers.mcp-unity',
      'Server~',
      'build'
    );
    const settingsPath = path.join(hostRoot, 'ProjectSettings', 'McpUnitySettings.json');

    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ RequestTimeoutSeconds: 60 }), 'utf8');

    const resolved = await resolveMcpUnitySettingsPath('/tmp/not-the-host-project', moduleDir);

    expect(resolved).toBe(settingsPath);

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('uses MCP_UNITY_WORKSPACE_ROOT when present', () => {
    const resolved = resolveExpectedWorkspaceRoot(
      { MCP_UNITY_WORKSPACE_ROOT: '/tmp/agent-workspace' } as NodeJS.ProcessEnv,
      '/tmp/fallback-cwd'
    );

    expect(resolved).toBe('/tmp/agent-workspace');
  });

  it('falls back to cwd when MCP_UNITY_WORKSPACE_ROOT is missing', () => {
    const resolved = resolveExpectedWorkspaceRoot(
      {} as NodeJS.ProcessEnv,
      '/tmp/fallback-cwd'
    );

    expect(resolved).toBe('/tmp/fallback-cwd');
  });

  it('normalizes path separators and trailing slashes', () => {
    expect(normalizeWorkspacePath('/Users/test/workspace/')).toBe('/Users/test/workspace');
    expect(normalizeWorkspacePath('/Users/test//workspace//')).toBe('/Users/test/workspace');
    expect(normalizeWorkspacePath('\\Users\\test\\workspace\\')).toBe('/Users/test/workspace');
  });

  it('matches equivalent paths after normalization', () => {
    expect(pathsMatch('/Users/test/workspace/', '/Users/test/workspace')).toBe(true);
    expect(pathsMatch('/Users/test//workspace', '\\Users\\test\\workspace\\')).toBe(true);
    expect(pathsMatch('/Users/test/workspace', '/Users/test/another')).toBe(false);
  });
});

describe('Logger with path-related messages', () => {
  it('should log messages containing paths with spaces', () => {
    const logger = new Logger('Test', LogLevel.ERROR);
    const pathWithSpaces = '/Users/John Doe/My Project/file.txt';

    // Logger should handle any string including paths with spaces
    // This is a smoke test to ensure no exceptions are thrown
    expect(() => {
      logger.error(`Failed to read file: ${pathWithSpaces}`);
    }).not.toThrow();
  });
});

describe('Transform schema compatibility', () => {
  const mockSendRequest = jest.fn();
  const mockMcpUnity = { sendRequest: mockSendRequest };
  const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  const mockServerTool = jest.fn();
  const mockServer = { tool: mockServerTool };

  function collectLocalPropertyRefs(node: unknown, refs: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const item of node) {
        collectLocalPropertyRefs(item, refs);
      }
      return refs;
    }

    if (!node || typeof node !== 'object') {
      return refs;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/properties/')) {
        refs.push(value);
      }
      collectLocalPropertyRefs(value, refs);
    }

    return refs;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers transform tools', () => {
    registerTransformTools(mockServer as any, mockMcpUnity as any, mockLogger as any);

    expect(mockServerTool).toHaveBeenCalledTimes(4);
    expect(mockServerTool).toHaveBeenCalledWith('move_gameobject', expect.any(String), expect.any(Object), expect.any(Function));
    expect(mockServerTool).toHaveBeenCalledWith('rotate_gameobject', expect.any(String), expect.any(Object), expect.any(Function));
    expect(mockServerTool).toHaveBeenCalledWith('scale_gameobject', expect.any(String), expect.any(Object), expect.any(Function));
    expect(mockServerTool).toHaveBeenCalledWith('set_transform', expect.any(String), expect.any(Object), expect.any(Function));
  });

  it('does not emit local #/properties refs for transform tool schemas', () => {
    registerTransformTools(mockServer as any, mockMcpUnity as any, mockLogger as any);

    for (const call of mockServerTool.mock.calls) {
      const paramsShape = call[2];
      const schemaJson = zodToJsonSchema(z.object(paramsShape), { strictUnions: true });
      const refs = collectLocalPropertyRefs(schemaJson);

      expect(refs).toEqual([]);
    }
  });
});

describe('Project affinity handshake gate', () => {
  const logger = new Logger('Test', LogLevel.ERROR);

  function createConnectedMcpUnity(): any {
    const unity = new McpUnity(logger) as any;
    unity.connection = {
      isConnected: true,
      connectionState: ConnectionState.Connected,
      connect: jest.fn().mockResolvedValue(undefined)
    };
    unity.sendRequestInternal = jest.fn().mockResolvedValue({ success: true });
    return unity;
  }

  it('validates project affinity before sending non-handshake requests', async () => {
    const unity = createConnectedMcpUnity();
    unity.handshakeValidated = false;
    unity.validateProjectAffinity = jest.fn().mockResolvedValue(undefined);

    await unity.sendRequest({ method: 'run_tests', params: {} });

    expect(unity.validateProjectAffinity).toHaveBeenCalledTimes(1);
    expect(unity.sendRequestInternal).toHaveBeenCalledTimes(1);
  });

  it('allows handshake requests without prior validation', async () => {
    const unity = createConnectedMcpUnity();
    unity.handshakeValidated = false;
    unity.validateProjectAffinity = jest.fn().mockResolvedValue(undefined);

    await unity.sendRequest({ method: 'mcp_unity_handshake', params: {} });

    expect(unity.validateProjectAffinity).not.toHaveBeenCalled();
    expect(unity.sendRequestInternal).toHaveBeenCalledTimes(1);
  });

  it('blocks non-handshake requests when validation fails', async () => {
    const unity = createConnectedMcpUnity();
    unity.handshakeValidated = false;
    unity.validateProjectAffinity = jest
      .fn()
      .mockRejectedValue(new McpUnityError(ErrorType.PROJECT_MISMATCH, 'Mismatch'));

    await expect(unity.sendRequest({ method: 'run_tests', params: {} })).rejects.toMatchObject({
      type: ErrorType.PROJECT_MISMATCH
    });
    expect(unity.sendRequestInternal).not.toHaveBeenCalled();
  });

  it('revalidates on reconnect before replaying queued commands', async () => {
    const unity = createConnectedMcpUnity();
    unity.validateProjectAffinity = jest.fn().mockResolvedValue(undefined);
    unity.replayQueuedCommands = jest.fn().mockResolvedValue(undefined);

    unity.handleStateChange({
      previousState: ConnectionState.Reconnecting,
      currentState: ConnectionState.Connected
    });

    await new Promise(resolve => setImmediate(resolve));

    expect(unity.validateProjectAffinity).toHaveBeenCalledTimes(1);
    expect(unity.replayQueuedCommands).toHaveBeenCalledTimes(1);
  });
});

describe('Connection error handling policy', () => {
  const logger = new Logger('Test', LogLevel.ERROR);

  it('does not reject all pending requests on transient connection error event', () => {
    const unity = new McpUnity(logger) as any;
    unity.rejectAllPendingRequests = jest.fn();

    unity.handleConnectionError(new McpUnityError(ErrorType.CONNECTION, 'transient socket error'));

    expect(unity.rejectAllPendingRequests).not.toHaveBeenCalled();
  });
});

describe('Timeout policy defaults', () => {
  const logger = new Logger('Test', LogLevel.ERROR);

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
});
