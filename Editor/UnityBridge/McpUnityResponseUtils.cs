using System;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace McpUnity.Unity
{
    public static class McpUnityResponseUtils
    {
        public static JObject CreateErrorResponse(string message, string errorType, JObject details = null)
        {
            var errorObject = new JObject
            {
                ["type"] = errorType,
                ["message"] = message
            };

            if (details != null)
            {
                errorObject["details"] = details;
            }

            return new JObject
            {
                ["error"] = errorObject
            };
        }

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

        public static JObject CreateProjectHandshakeResponse(string expectedWorkspacePath, string unityProjectPath)
        {
            string normalizedExpectedPath = NormalizeProjectPath(expectedWorkspacePath);
            string normalizedUnityProjectPath = NormalizeProjectPath(unityProjectPath);

            if (string.IsNullOrEmpty(normalizedExpectedPath))
            {
                return CreateErrorResponse(
                    "Missing expectedWorkspacePath in handshake request",
                    "invalid_request");
            }

            bool caseInsensitiveComparison = Application.platform == RuntimePlatform.WindowsEditor;
            if (!PathsMatch(normalizedExpectedPath, normalizedUnityProjectPath, caseInsensitiveComparison))
            {
                return CreateErrorResponse(
                    "Connected Unity project does not match the MCP workspace path",
                    "project_mismatch_error",
                    new JObject
                    {
                        ["expectedPath"] = normalizedExpectedPath,
                        ["actualPath"] = normalizedUnityProjectPath
                    });
            }

            return new JObject
            {
                ["success"] = true,
                ["matched"] = true,
                ["unityProjectPath"] = normalizedUnityProjectPath,
                ["message"] = "Project affinity validated"
            };
        }

        public static string GetCurrentProjectPath()
        {
            try
            {
                string dataPath = Application.dataPath;
                return Directory.GetParent(dataPath)?.FullName ?? string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        public static string NormalizeProjectPath(string projectPath)
        {
            if (string.IsNullOrWhiteSpace(projectPath))
            {
                return string.Empty;
            }

            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(projectPath);
            }
            catch
            {
                fullPath = projectPath;
            }

            string normalized = fullPath.Replace('\\', '/');
            while (normalized.Contains("//"))
            {
                normalized = normalized.Replace("//", "/");
            }

            bool isWindowsDriveRoot = normalized.Length == 3 &&
                                      char.IsLetter(normalized[0]) &&
                                      normalized[1] == ':' &&
                                      normalized[2] == '/';

            if (normalized != "/" && !isWindowsDriveRoot)
            {
                normalized = normalized.TrimEnd('/');
            }

            return normalized;
        }

        public static bool PathsMatch(string expectedPath, string actualPath, bool caseInsensitive = false)
        {
            string normalizedExpected = NormalizeProjectPath(expectedPath);
            string normalizedActual = NormalizeProjectPath(actualPath);

            if (string.IsNullOrEmpty(normalizedExpected) || string.IsNullOrEmpty(normalizedActual))
            {
                return false;
            }

            return string.Equals(
                normalizedExpected,
                normalizedActual,
                caseInsensitive ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
        }
    }
}
