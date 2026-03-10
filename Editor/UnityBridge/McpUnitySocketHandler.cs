using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using WebSocketSharp;
using WebSocketSharp.Server;
using McpUnity.Tools;
using McpUnity.Resources;
using Unity.EditorCoroutines.Editor;
using System.Collections;
using System.Collections.Specialized;
using McpUnity.Utils;

namespace McpUnity.Unity
{
    /// <summary>
    /// WebSocket handler for MCP Unity communications
    /// </summary>
    public class McpUnitySocketHandler : WebSocketBehavior
    {
        private readonly McpUnityServer _server;
        
        /// <summary>
        /// Default constructor required by WebSocketSharp
        /// </summary>
        public McpUnitySocketHandler(McpUnityServer server)
        {
            _server = server;
        }
        
        /// <summary>
        /// Create a standardized error response
        /// </summary>
        /// <param name="message">Error message</param>
        /// <param name="errorType">Type of error</param>
        /// <returns>A JObject containing the error information</returns>
        public static JObject CreateErrorResponse(string message, string errorType)
        {
            return new JObject
            {
                ["error"] = new JObject
                {
                    ["type"] = errorType,
                    ["message"] = message
                }
            };
        }

        /// <summary>
        /// Create a busy response for conflicting write operations.
        /// </summary>
        public static JObject CreateBusyResponse(string activeOperation, string activeClientName)
        {
            var message = "Another write operation is already in progress.";

            if (!string.IsNullOrEmpty(activeOperation))
            {
                message += $" Active operation: {activeOperation}.";
            }

            if (!string.IsNullOrEmpty(activeClientName))
            {
                message += $" Active client: {activeClientName}.";
            }

            var details = new JObject
            {
                ["retryable"] = true
            };

            if (!string.IsNullOrEmpty(activeOperation))
            {
                details["activeOperation"] = activeOperation;
            }

            if (!string.IsNullOrEmpty(activeClientName))
            {
                details["activeClientName"] = activeClientName;
            }

            return new JObject
            {
                ["error"] = new JObject
                {
                    ["type"] = "busy_error",
                    ["message"] = message,
                    ["details"] = details
                }
            };
        }
        
        /// <summary>
        /// Handle incoming messages from WebSocket clients
        /// </summary>
        protected override async void OnMessage(MessageEventArgs e)
        {
            var hasWriteLease = false;

            try
            {
                McpLogger.LogInfo($"WebSocket message received: {e.Data}");
                JObject requestJson;
                try
                {
                    requestJson = JObject.Parse(e.Data);
                }
                catch (JsonReaderException jre)
                {
                    McpLogger.LogError($"Invalid JSON received: {jre.Message}. Data: {e.Data}");
                    // Attempt to send a parse error response. No requestId is available yet.
                    Send(CreateResponse(null, CreateErrorResponse($"Invalid JSON format: {jre.Message}", "invalid_json")).ToString(Formatting.None));
                    return;
                }

                var method = requestJson["method"]?.ToString();
                var parameters = requestJson["params"] as JObject ?? new JObject();
                var requestId = requestJson["id"]?.ToString();
                var clientName = GetClientName();
                // We need to dispatch to Unity's main thread and wait for completion
                var tcs = new TaskCompletionSource<JObject>();
                
                if (string.IsNullOrEmpty(method))
                {
                    tcs.SetResult(CreateErrorResponse("Missing method in request", "invalid_request"));
                }
                else if (_server.TryGetTool(method, out var tool))
                {
                    if (!TryAcquireWriteLease(tool.OperationKind, method, clientName, requestId))
                    {
                        return;
                    }

                    hasWriteLease = tool.OperationKind != McpOperationKind.Read;
                    EditorCoroutineUtility.StartCoroutineOwnerless(ExecuteTool(tool, parameters, tcs));
                }
                else if (_server.TryGetResource(method, out var resource))
                {
                    if (!TryAcquireWriteLease(resource.OperationKind, method, clientName, requestId))
                    {
                        return;
                    }

                    hasWriteLease = resource.OperationKind != McpOperationKind.Read;
                    EditorCoroutineUtility.StartCoroutineOwnerless(FetchResourceCoroutine(resource, parameters, tcs));
                }
                else
                {
                    tcs.SetResult(CreateErrorResponse($"Unknown method: {method}", "unknown_method"));
                }
                
                JObject responseJson = await tcs.Task;
                JObject jsonRpcResponse = CreateResponse(requestId, responseJson);
                string responseStr = jsonRpcResponse.ToString(Formatting.None);
                
                McpLogger.LogInfo($"WebSocket message response for request ID '{requestId}': {responseStr}");
                
                // Send the response back to the client
                Send(responseStr);
            }
            catch (Exception ex)
            {
                McpLogger.LogError($"Error processing message: {ex.Message}");
                
                Send(CreateErrorResponse($"Internal server error: {ex.Message}", "internal_error").ToString(Formatting.None));
            }
            finally
            {
                if (hasWriteLease)
                {
                    _server.ExecutionGate.ExitWrite(ID);
                    McpLogger.LogInfo($"Released write execution lease for session {ID}");
                }
            }
        }
        
        /// <summary>
        /// Handle WebSocket connection open and register the client for multi-session tracking.
        /// </summary>
        protected override void OnOpen()
        {
            // Extract client name from the X-Client-Name header (if available)
            string clientName = "";
            NameValueCollection headers = Context.Headers;
            if (headers != null && headers.Contains("X-Client-Name"))
            {
                clientName = headers["X-Client-Name"];
            }

            // Always add the client to the server's tracking dictionary
            _server.Clients[ID] = clientName;

            McpLogger.LogInfo($"WebSocket client connected (ID: {ID}, Name: {(string.IsNullOrEmpty(clientName) ? "Unknown" : clientName)})");
        }
        
        /// <summary>
        /// Handle WebSocket connection close
        /// </summary>
        protected override void OnClose(CloseEventArgs e)
        {
            _server.Clients.TryGetValue(ID, out string clientName);
            
            // Remove the client from the server
            _server.Clients.TryRemove(ID, out _);
            
            McpLogger.LogInfo($"WebSocket client '{clientName}' disconnected: {e.Reason}");
        }
        
        /// <summary>
        /// Handle WebSocket errors
        /// </summary>
        protected override void OnError(ErrorEventArgs e)
        {
            McpLogger.LogError($"WebSocket error: {e.Message}");
        }
        
        /// <summary>
        /// Execute a tool with the provided parameters
        /// </summary>
        private IEnumerator ExecuteTool(McpToolBase tool, JObject parameters, TaskCompletionSource<JObject> tcs)
        {
            try
            {
                if (tool.IsAsync)
                {
                    tool.ExecuteAsync(parameters, tcs);
                }
                else
                {
                    var result = tool.Execute(parameters);
                    tcs.SetResult(result);
                }
            }
            catch (Exception ex)
            {
                McpLogger.LogError($"Error executing tool {tool.Name}: {ex.Message}\n{ex.StackTrace}");
                tcs.SetResult(CreateErrorResponse(
                    $"Failed to execute tool {tool.Name}: {ex.Message}",
                    "tool_execution_error"
                ));
            }
            
            yield return null;
        }
        
        /// <summary>
        /// Fetch a resource with the provided parameters
        /// </summary>
        private IEnumerator FetchResourceCoroutine(McpResourceBase resource, JObject parameters, TaskCompletionSource<JObject> tcs)
        {
            try
            {
                if (resource.IsAsync)
                {
                    resource.FetchAsync(parameters, tcs);
                }
                else
                {
                    var result = resource.Fetch(parameters);
                    tcs.SetResult(result);
                }
            }
            catch (Exception ex)
            {
                McpLogger.LogError($"Error fetching resource {resource.Name}: {ex.Message}\n{ex.StackTrace}");
                tcs.SetResult(CreateErrorResponse(
                    $"Failed to fetch resource {resource.Name}: {ex.Message}",
                    "resource_fetch_error"
                ));
            }
            yield return null;
        }

        private string GetClientName()
        {
            if (_server.Clients.TryGetValue(ID, out var clientName) && !string.IsNullOrEmpty(clientName))
            {
                return clientName;
            }

            NameValueCollection headers = Context?.Headers;
            if (headers != null && headers.Contains("X-Client-Name"))
            {
                return headers["X-Client-Name"];
            }

            return string.Empty;
        }

        private bool TryAcquireWriteLease(McpOperationKind operationKind, string method, string clientName, string requestId)
        {
            if (operationKind == McpOperationKind.Read)
            {
                return true;
            }

            if (_server.ExecutionGate.TryEnterWrite(ID, clientName, method))
            {
                McpLogger.LogInfo($"Granted write execution lease for method '{method}' to session {ID}");
                return true;
            }

            var busyResponse = CreateResponse(
                requestId,
                CreateBusyResponse(_server.ExecutionGate.ActiveOperation, _server.ExecutionGate.ActiveClientName));
            McpLogger.LogWarning(
                $"Rejected write request '{method}' for session {ID} because '{_server.ExecutionGate.ActiveOperation}' is already running.");
            Send(busyResponse.ToString(Formatting.None));
            return false;
        }
        
        /// <summary>
        /// Create a JSON-RPC 2.0 response
        /// </summary>
        /// <param name="requestId">Request ID</param>
        /// <param name="result">Result object</param>
        /// <returns>JSON-RPC 2.0 response</returns>
        private JObject CreateResponse(string requestId, JObject result)
        {
            // Format as JSON-RPC 2.0 response
            JObject jsonRpcResponse = new JObject
            {
                ["id"] = requestId
            };
            
            // Add result or error
            if (result.TryGetValue("error", out var errorObj))
            {
                jsonRpcResponse["error"] = errorObj;
            }
            else
            {
                jsonRpcResponse["result"] = result;
            }
            
            return jsonRpcResponse;
        }
    }
}
