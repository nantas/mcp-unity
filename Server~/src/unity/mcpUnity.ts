import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { McpUnityError, ErrorType } from '../utils/errors.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { UnityConnection, ConnectionState, ConnectionStateChange, UnityConnectionConfig } from './unityConnection.js';
import { CommandQueue, CommandQueueConfig, CommandQueueStats, QueuedCommand } from './commandQueue.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_UNITY_SETTINGS_RELATIVE_PATH = path.join('ProjectSettings', 'McpUnitySettings.json');
const HANDSHAKE_METHOD = 'mcp_unity_handshake';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}

interface UnityRequest {
  id?: string;
  method: string;
  params: any;
}

interface UnityResponse {
  jsonrpc: string;
  id: string;
  result?: any;
  error?: {
    message: string;
    type: string;
    details?: any;
  };
}

function trimTrailingSlashes(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value;
  }

  return value.replace(/\/+$/g, '');
}

export function normalizeWorkspacePath(inputPath: string, platform: NodeJS.Platform = process.platform): string {
  if (!inputPath || !inputPath.trim()) {
    return '';
  }

  const normalizedInput = inputPath.trim().replace(/\\/g, '/');
  const isPosixAbsolute = normalizedInput.startsWith('/');
  const isWindowsDriveAbsolute = /^[A-Za-z]:\//.test(normalizedInput);
  const resolved = isPosixAbsolute || isWindowsDriveAbsolute
    ? normalizedInput
    : path.resolve(normalizedInput);
  const normalizedSeparators = resolved.replace(/\\/g, '/');
  const deduped = normalizedSeparators.replace(/\/{2,}/g, '/');
  const withoutTrailing = trimTrailingSlashes(deduped);

  return platform === 'win32' ? withoutTrailing.toLowerCase() : withoutTrailing;
}

export function pathsMatch(leftPath: string, rightPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalizedLeft = normalizeWorkspacePath(leftPath, platform);
  const normalizedRight = normalizeWorkspacePath(rightPath, platform);

  return normalizedLeft.length > 0 &&
         normalizedRight.length > 0 &&
         normalizedLeft === normalizedRight;
}

export function resolveExpectedWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const overridePath = env.MCP_UNITY_WORKSPACE_ROOT?.trim();
  return overridePath && overridePath.length > 0 ? overridePath : cwd;
}

export function mapUnityResponseError(error: UnityResponse['error']): McpUnityError {
  if (error?.type === ErrorType.BUSY) {
    return new McpUnityError(
      ErrorType.BUSY,
      error.message || 'Unity writer is busy',
      error.details
    );
  }

  if (error?.type === ErrorType.PROJECT_MISMATCH) {
    return new McpUnityError(
      ErrorType.PROJECT_MISMATCH,
      error.message || 'Unity project path does not match current workspace',
      error.details
    );
  }

  return new McpUnityError(
    ErrorType.TOOL_EXECUTION,
    error?.message || 'Unknown error',
    error?.details
  );
}

/**
 * Connection state change callback type
 */
export type ConnectionStateCallback = (change: ConnectionStateChange) => void;

// Re-export connection types for consumers
export { ConnectionState, type ConnectionStateChange } from './unityConnection.js';
export { type CommandQueueConfig, type CommandQueueStats } from './commandQueue.js';

async function findNearestSettingsPath(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, MCP_UNITY_SETTINGS_RELATIVE_PATH);

    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep walking upward until we either find the host ProjectSettings or reach the filesystem root.
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export async function resolveMcpUnitySettingsPath(
  cwd: string = process.cwd(),
  moduleDir: string = MODULE_DIR
): Promise<string> {
  for (const startDir of [cwd, moduleDir]) {
    const resolved = await findNearestSettingsPath(startDir);
    if (resolved) {
      return resolved;
    }
  }

  return path.resolve(cwd, MCP_UNITY_SETTINGS_RELATIVE_PATH);
}

/**
 * Options for sending a request
 */
export interface SendRequestOptions {
  /** If true, queue the command when disconnected instead of failing immediately (default: uses queueingEnabled setting) */
  queueIfDisconnected?: boolean;
  /** Custom timeout for this request in milliseconds */
  timeout?: number;
}

/**
 * Configuration for McpUnity
 */
export interface McpUnityConfig {
  /** Command queue configuration */
  queue?: CommandQueueConfig;
  /** Whether command queuing is enabled by default (default: true) */
  queueingEnabled?: boolean;
}

export class McpUnity {
  private logger: Logger;
  private port: number = 8090;
  private host: string = 'localhost';
  private requestTimeout = 10000;

  private connection: UnityConnection | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map<string, PendingRequest>();
  private clientName: string = '';

  // Connection state listeners
  private stateListeners: Set<ConnectionStateCallback> = new Set();

  // Command queue for handling commands during disconnection
  private commandQueue: CommandQueue;
  private queueingEnabled: boolean;

  // Flag to track if we're currently replaying queued commands
  private isReplayingQueue: boolean = false;
  private handshakeValidated: boolean = false;
  private handshakeInFlight: Promise<void> | null = null;
  private expectedWorkspacePath: string = '';
  private allowUnverifiedProjectValidation: boolean = false;

  constructor(logger: Logger, config?: McpUnityConfig) {
    this.logger = logger;
    this.commandQueue = new CommandQueue(logger, config?.queue);
    this.queueingEnabled = config?.queueingEnabled ?? true;
  }

  /**
   * Enable or disable command queuing
   */
  public setQueueingEnabled(enabled: boolean): void {
    this.queueingEnabled = enabled;
    this.logger.info(`Command queuing ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if command queuing is enabled
   */
  public get isQueueingEnabled(): boolean {
    return this.queueingEnabled;
  }

  /**
   * Get command queue statistics
   */
  public getQueueStats(): CommandQueueStats {
    return this.commandQueue.getStats();
  }

  /**
   * Get number of commands currently queued
   */
  public get queuedCommandCount(): number {
    return this.commandQueue.size;
  }

  /**
   * Start the Unity connection
   * @param clientName Optional name of the MCP client connecting to Unity
   */
  public async start(clientName?: string): Promise<void> {
    try {
      this.logger.info('Attempting to read startup parameters...');
      await this.parseAndSetConfig();
      this.expectedWorkspacePath = normalizeWorkspacePath(resolveExpectedWorkspaceRoot());
      this.allowUnverifiedProjectValidation = process.env.MCP_UNITY_ALLOW_UNVERIFIED === 'true';

      this.clientName = clientName || '';

      // Create connection with configuration
      const config: UnityConnectionConfig = {
        host: this.host,
        port: this.port,
        requestTimeout: this.requestTimeout,
        clientName: this.clientName,
        // Use defaults for reconnection and heartbeat from UnityConnection
      };

      this.connection = new UnityConnection(this.logger, config);

      // Set up event handlers
      this.connection.on('stateChange', (change: ConnectionStateChange) => {
        this.handleStateChange(change);
      });

      this.connection.on('message', (data: string) => {
        this.handleMessage(data);
      });

      this.connection.on('error', (error: McpUnityError) => {
        this.logger.error(`Connection error: ${error.message}`);
        // Reject pending requests on connection error
        this.rejectAllPendingRequests(error);
      });

      this.logger.info('Attempting to connect to Unity WebSocket...');
      await this.connection.connect();
      this.logger.info('Successfully connected to Unity WebSocket');
      await this.ensureProjectAffinityValidated();

      if (clientName) {
        this.logger.info(`Client identified to Unity as: ${clientName}`);
      }
    } catch (error) {
      this.logger.warn(`Could not connect to Unity WebSocket: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.warn('Will retry connection on next request (with automatic reconnection)');
    }

    return Promise.resolve();
  }

  /**
   * Reads our configuration file and sets parameters of the server based on them.
   */
  private async parseAndSetConfig() {
    const config = await this.readConfigFileAsJson();

    const configPort = config.Port;
    this.port = configPort ? parseInt(configPort, 10) : 8090;
    this.logger.info(`Using port: ${this.port} for Unity WebSocket connection`);

    // Check environment variable first, then config file, then default to localhost
    const configHost = process.env.UNITY_HOST || config.Host;
    this.host = configHost || 'localhost';

    // Initialize timeout from environment variable (in seconds; it is the same as Cline) or use default (10 seconds)
    const configTimeout = config.RequestTimeoutSeconds;
    this.requestTimeout = configTimeout ? parseInt(configTimeout, 10) * 1000 : 10000;
    this.logger.info(`Using request timeout: ${this.requestTimeout / 1000} seconds`);
  }

  /**
   * Handle connection state changes
   */
  private handleStateChange(change: ConnectionStateChange): void {
    this.logger.debug(`Connection state changed: ${change.previousState} -> ${change.currentState}`);

    // Notify all listeners
    for (const listener of this.stateListeners) {
      try {
        listener(change);
      } catch (err) {
        this.logger.error(`Error in state listener: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Handshake must be re-established for every reconnection/disconnection cycle.
    if (change.currentState === ConnectionState.Connecting ||
        change.currentState === ConnectionState.Reconnecting ||
        change.currentState === ConnectionState.Disconnected) {
      this.handshakeValidated = false;
      this.handshakeInFlight = null;
    }

    // Handle specific state transitions
    if (change.currentState === ConnectionState.Connected &&
        (change.previousState === ConnectionState.Reconnecting ||
         change.previousState === ConnectionState.Connecting)) {
      void this.validateAfterReconnectAndReplayQueue();
    } else if (change.currentState === ConnectionState.Disconnected) {
      // Clear the queue when we're fully disconnected (not reconnecting)
      // This happens when max reconnection attempts are reached
      if (change.reason?.includes('Max reconnection attempts')) {
        this.commandQueue.clear(change.reason);
      }
      // Reject all pending requests when disconnected
      this.rejectAllPendingRequests(
        new McpUnityError(ErrorType.CONNECTION, change.reason || 'Connection lost')
      );
    }
  }

  /**
   * Replay queued commands after connection is restored
   */
  private async replayQueuedCommands(): Promise<void> {
    if (this.isReplayingQueue) {
      this.logger.debug('Already replaying queue, skipping');
      return;
    }

    await this.ensureProjectAffinityValidated();

    const commands = this.commandQueue.drain();

    if (commands.length === 0) {
      return;
    }

    this.isReplayingQueue = true;
    this.logger.info(`Replaying ${commands.length} queued commands`);

    for (const command of commands) {
      try {
        // Send the command directly using internal method
        const result = await this.sendRequestInternal(command.request, command.timeout);
        command.resolve(result);
        this.commandQueue.recordReplaySuccess();
      } catch (error) {
        command.reject(error);
      }
    }

    this.isReplayingQueue = false;
    this.logger.info(`Finished replaying queued commands (${this.commandQueue.getStats().replayedCount} successful)`);
  }

  private async validateAfterReconnectAndReplayQueue(): Promise<void> {
    try {
      await this.ensureProjectAffinityValidated();
      await this.replayQueuedCommands();
    } catch (error) {
      const mappedError = error instanceof McpUnityError
        ? error
        : new McpUnityError(
            ErrorType.CONNECTION,
            `Project validation failed after reconnect: ${error instanceof Error ? error.message : String(error)}`
          );
      this.logger.error(`Unable to replay queued commands: ${mappedError.message}`);
      this.rejectAllQueuedCommands(mappedError);
    }
  }

  private rejectAllQueuedCommands(error: McpUnityError): void {
    const queuedCommands = this.commandQueue.drain();
    for (const command of queuedCommands) {
      command.reject(error);
    }
  }

  /**
   * Handle messages received from Unity
   */
  private handleMessage(data: string): void {
    try {
      const response = JSON.parse(data) as UnityResponse;

      if (response.id && this.pendingRequests.has(response.id)) {
        const request = this.pendingRequests.get(response.id)!;
        clearTimeout(request.timeout);
        this.pendingRequests.delete(response.id);

        if (response.error) {
          request.reject(mapUnityResponseError(response.error));
        } else {
          request.resolve(response.result);
        }
      }
    } catch (e) {
      this.logger.error(`Error parsing WebSocket message: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Reject all pending requests with an error
   */
  private rejectAllPendingRequests(error: McpUnityError): void {
    for (const [id, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Stop the Unity connection and clean up resources
   */
  public async stop(): Promise<void> {
    // Dispose the command queue
    this.commandQueue.dispose();

    if (this.connection) {
      this.connection.disconnect('Server stopping');
      this.connection.removeAllListeners();
      this.connection = null;
    }
    this.rejectAllPendingRequests(new McpUnityError(ErrorType.CONNECTION, 'Server stopped'));
    this.logger.info('Unity WebSocket client stopped');
    return Promise.resolve();
  }

  /**
   * Send a request to the Unity server
   * @param request The request to send
   * @param options Optional settings for the request
   */
  public async sendRequest(request: UnityRequest, options: SendRequestOptions = {}): Promise<any> {
    const { queueIfDisconnected = this.queueingEnabled, timeout } = options;
    const requestId = request.id as string || uuidv4();
    const message: UnityRequest = {
      ...request,
      id: requestId
    };

    // If connected, send directly
    if (this.isConnected) {
      if (this.requiresProjectValidation(request.method)) {
        await this.ensureProjectAffinityValidated();
      }
      return this.sendRequestInternal(message, timeout);
    }

    // If not started, throw error
    if (!this.connection) {
      throw new McpUnityError(ErrorType.CONNECTION, 'Not started - call start() first');
    }

    // If reconnecting and queuing is enabled, queue the command
    if (queueIfDisconnected && this.connectionState === ConnectionState.Reconnecting) {
      this.logger.debug(`Queuing command ${requestId} (${request.method}) - reconnecting...`);

      return new Promise((resolve, reject) => {
        const result = this.commandQueue.enqueue({
          id: requestId,
          request: message,
          resolve,
          reject,
          timeout
        });

        if (result.success) {
          this.logger.info(`Command ${requestId} queued at position ${result.position}`);
        }
        // If queuing failed, the command was already rejected by the queue
      });
    }

    // If connecting and queuing is enabled, queue the command
    if (queueIfDisconnected && this.connectionState === ConnectionState.Connecting) {
      this.logger.debug(`Queuing command ${requestId} (${request.method}) - connecting...`);

      return new Promise((resolve, reject) => {
        const result = this.commandQueue.enqueue({
          id: requestId,
          request: message,
          resolve,
          reject,
          timeout
        });

        if (result.success) {
          this.logger.info(`Command ${requestId} queued at position ${result.position}`);
        }
      });
    }

    // Not connected - try to connect first
    this.logger.info('Not connected to Unity, connecting first...');

    try {
      await this.connection.connect();
      if (this.requiresProjectValidation(request.method)) {
        await this.ensureProjectAffinityValidated();
      }
      // Connection successful, send the request
      return this.sendRequestInternal(message, timeout);
    } catch (error) {
      // Connection failed - if queuing is enabled, queue the command
      if (queueIfDisconnected) {
        this.logger.debug(`Queuing command ${requestId} (${request.method}) - connection failed, will retry`);

        return new Promise((resolve, reject) => {
          const result = this.commandQueue.enqueue({
            id: requestId,
            request: message,
            resolve,
            reject,
            timeout
          });

          if (result.success) {
            this.logger.info(`Command ${requestId} queued at position ${result.position}, waiting for reconnection`);
          }
        });
      }

      throw new McpUnityError(
        ErrorType.CONNECTION,
        `Not connected to Unity: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private requiresProjectValidation(method: string): boolean {
    return !this.allowUnverifiedProjectValidation && method !== HANDSHAKE_METHOD;
  }

  private async ensureProjectAffinityValidated(): Promise<void> {
    if (this.allowUnverifiedProjectValidation) {
      this.handshakeValidated = true;
      return;
    }

    if (this.handshakeValidated) {
      return;
    }

    await this.validateProjectAffinity();
  }

  private async validateProjectAffinity(): Promise<void> {
    if (this.allowUnverifiedProjectValidation) {
      this.handshakeValidated = true;
      return;
    }

    if (!this.connection || !this.isConnected) {
      throw new McpUnityError(ErrorType.CONNECTION, 'Cannot validate project affinity while disconnected');
    }

    if (this.handshakeInFlight) {
      return this.handshakeInFlight;
    }

    if (!this.expectedWorkspacePath) {
      this.expectedWorkspacePath = normalizeWorkspacePath(resolveExpectedWorkspaceRoot());
    }

    this.handshakeInFlight = (async () => {
      const requestId = uuidv4();
      const response = await this.sendRequestInternal({
        id: requestId,
        method: HANDSHAKE_METHOD,
        params: {
          expectedWorkspacePath: this.expectedWorkspacePath
        }
      }, this.requestTimeout);

      const unityProjectPath = normalizeWorkspacePath(response?.unityProjectPath ?? '');
      const matched = response?.matched === true || pathsMatch(this.expectedWorkspacePath, unityProjectPath);

      if (!response?.success || !matched) {
        throw new McpUnityError(
          ErrorType.PROJECT_MISMATCH,
          response?.message || 'Workspace does not match Unity project',
          {
            expectedPath: this.expectedWorkspacePath,
            actualPath: unityProjectPath || response?.unityProjectPath || ''
          }
        );
      }

      this.handshakeValidated = true;
      this.logger.info(`Project affinity validated: ${this.expectedWorkspacePath}`);
    })();

    try {
      await this.handshakeInFlight;
    } catch (error) {
      this.handshakeValidated = false;
      throw error;
    } finally {
      this.handshakeInFlight = null;
    }
  }

  /**
   * Internal method to send a request directly to Unity
   * Bypasses queuing logic - assumes connection is already established
   */
  private sendRequestInternal(request: UnityRequest, customTimeout?: number): Promise<any> {
    const requestId = request.id as string;
    const timeoutMs = customTimeout ?? this.requestTimeout;

    return new Promise((resolve, reject) => {
      if (!this.connection || !this.isConnected) {
        reject(new McpUnityError(ErrorType.CONNECTION, 'Not connected to Unity'));
        return;
      }

      // Create timeout for the request
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.logger.error(`Request ${requestId} timed out after ${timeoutMs}ms`);
          this.pendingRequests.delete(requestId);
          reject(new McpUnityError(ErrorType.TIMEOUT, 'Request timed out'));

          // Force reconnection on timeout (connection may be stale)
          if (this.connection) {
            this.connection.forceReconnect();
          }
        }
      }, timeoutMs);

      // Store pending request
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout
      });

      try {
        this.connection.send(JSON.stringify(request));
        this.logger.debug(`Request sent: ${requestId}`);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new McpUnityError(ErrorType.CONNECTION, `Send failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /**
   * Check if connected to Unity
   * Only returns true if the connection is guaranteed to be active
   */
  public get isConnected(): boolean {
    return this.connection !== null && this.connection.isConnected;
  }

  /**
   * Get current connection state
   */
  public get connectionState(): ConnectionState {
    return this.connection?.connectionState ?? ConnectionState.Disconnected;
  }

  /**
   * Check if currently connecting or reconnecting
   */
  public get isConnecting(): boolean {
    return this.connection?.isConnecting ?? false;
  }

  /**
   * Add a listener for connection state changes
   * @param callback Function to call when connection state changes
   * @returns Function to remove the listener
   */
  public onConnectionStateChange(callback: ConnectionStateCallback): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * Force a reconnection to Unity
   * Useful when Unity has reloaded and the connection may be stale
   */
  public forceReconnect(): void {
    if (this.connection) {
      this.connection.forceReconnect();
    } else {
      this.logger.warn('Cannot force reconnect - not started');
    }
  }

  /**
   * Get connection statistics
   */
  public getConnectionStats(): {
    state: ConnectionState;
    pendingRequests: number;
    reconnectAttempt?: number;
    timeSinceLastPong?: number;
  } {
    const stats = this.connection?.getStats();
    return {
      state: stats?.state ?? ConnectionState.Disconnected,
      pendingRequests: this.pendingRequests.size,
      reconnectAttempt: stats?.reconnectAttempt,
      timeSinceLastPong: stats?.timeSinceLastPong
    };
  }

  /**
   * Read the McpUnitySettings.json file and return its contents as a JSON object.
   * @returns a JSON object with the contents of the McpUnitySettings.json file.
   */
  private async readConfigFileAsJson(): Promise<any> {
    const configPath = await resolveMcpUnitySettingsPath();
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(content);
      return json;
    } catch (err) {
      this.logger.debug(`McpUnitySettings.json not found or unreadable: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
}
