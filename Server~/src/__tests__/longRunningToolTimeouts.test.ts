import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { registerRunTestsTool } from '../tools/runTestsTool.js';
import { registerRecompileScriptsTool } from '../tools/recompileScriptsTool.js';
import { registerMenuItemTool } from '../tools/menuItemTool.js';

const LONG_RUNNING_TIMEOUT_MS = 120000;

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

function getHandler(toolName: string): (params?: any) => Promise<any> {
  const call = mockServerTool.mock.calls.find((args: any[]) => args[0] === toolName);
  if (!call) {
    throw new Error(`Tool handler not registered: ${toolName}`);
  }
  return call[3];
}

describe('Long-running tool timeout overrides', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerRunTestsTool(mockServer as any, mockMcpUnity as any, mockLogger as any);
    registerRecompileScriptsTool(mockServer as any, mockMcpUnity as any, mockLogger as any);
    registerMenuItemTool(mockServer as any, mockMcpUnity as any, mockLogger as any);
  });

  it('run_tests uses 120000ms request timeout override', async () => {
    mockSendRequest.mockResolvedValue({
      success: true,
      message: 'Tests completed',
      testCount: 0,
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      results: []
    });

    const handler = getHandler('run_tests');
    await handler({ testMode: 'EditMode' });

    expect(mockSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'run_tests' }),
      { timeout: LONG_RUNNING_TIMEOUT_MS }
    );
  });

  it('recompile_scripts and execute_menu_item use 120000ms timeout override', async () => {
    mockSendRequest
      .mockResolvedValueOnce({
        success: true,
        message: 'Compilation completed',
        logs: []
      })
      .mockResolvedValueOnce({
        success: true,
        type: 'text',
        message: 'Menu executed'
      });

    await getHandler('recompile_scripts')({});
    await getHandler('execute_menu_item')({ menuPath: 'Assets/Refresh' });

    expect(mockSendRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'recompile_scripts' }),
      { timeout: LONG_RUNNING_TIMEOUT_MS }
    );
    expect(mockSendRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: 'execute_menu_item' }),
      { timeout: LONG_RUNNING_TIMEOUT_MS }
    );
  });
});
