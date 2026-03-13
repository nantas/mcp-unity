using NUnit.Framework;
using Newtonsoft.Json.Linq;
using McpUnity.Unity;

namespace McpUnity.Tests
{
    public class McpUnityExecutionGateTests
    {
        [Test]
        public void TryEnterWrite_FailsWhenAnotherWriteIsActive()
        {
            var gate = new McpUnityExecutionGate();

            Assert.IsTrue(gate.TryEnterWrite("session-a", "client-a", "update_gameobject"));
            Assert.AreEqual("client-a", gate.ActiveClientName);
            Assert.AreEqual("update_gameobject", gate.ActiveOperation);
            Assert.IsFalse(gate.TryEnterWrite("session-b", "client-b", "save_scene"));
        }

        [Test]
        public void ExitWrite_ReleasesTheGate()
        {
            var gate = new McpUnityExecutionGate();

            Assert.IsTrue(gate.TryEnterWrite("session-a", "client-a", "update_gameobject"));

            gate.ExitWrite("session-a");

            Assert.IsNull(gate.ActiveClientName);
            Assert.IsNull(gate.ActiveOperation);

            Assert.IsTrue(gate.TryEnterWrite("session-b", "client-b", "save_scene"));
        }

        [Test]
        public void TryEnterWrite_StoresActiveWriterMetadata()
        {
            var gate = new McpUnityExecutionGate();

            Assert.IsTrue(gate.TryEnterWrite("session-a", "client-a", "update_gameobject"));
            Assert.AreEqual("client-a", gate.ActiveClientName);
            Assert.AreEqual("update_gameobject", gate.ActiveOperation);
        }

        [Test]
        public void ExitWrite_ClearsActiveWriterMetadata()
        {
            var gate = new McpUnityExecutionGate();

            Assert.IsTrue(gate.TryEnterWrite("session-a", "client-a", "update_gameobject"));

            gate.ExitWrite("session-a");

            Assert.IsNull(gate.ActiveClientName);
            Assert.IsNull(gate.ActiveOperation);
        }

        [Test]
        public void CreateBusyResponse_UsesBusyErrorType()
        {
            JObject response = McpUnitySocketHandler.CreateBusyResponse("update_gameobject", "Client A");

            Assert.AreEqual("busy_error", response["error"]?["type"]?.ToString());
            Assert.That(response["error"]?["message"]?.ToString(), Does.Contain("update_gameobject"));
            Assert.IsTrue(response["error"]?["details"]?["retryable"]?.ToObject<bool>() ?? false);
            Assert.AreEqual("update_gameobject", response["error"]?["details"]?["activeOperation"]?.ToString());
            Assert.AreEqual("Client A", response["error"]?["details"]?["activeClientName"]?.ToString());
        }

        [Test]
        public void CreateProjectHandshakeResponse_ReturnsSuccessWhenPathsMatch()
        {
            JObject response = McpUnitySocketHandler.CreateProjectHandshakeResponse(
                "/Volumes/Shuttle/unity-projects/mcp-unity",
                "/Volumes/Shuttle/unity-projects/mcp-unity/");

            Assert.IsNull(response["error"]);
            Assert.IsTrue(response["success"]?.ToObject<bool>() ?? false);
            Assert.IsTrue(response["matched"]?.ToObject<bool>() ?? false);
            Assert.AreEqual(
                "/Volumes/Shuttle/unity-projects/mcp-unity",
                response["unityProjectPath"]?.ToString());
        }

        [Test]
        public void CreateProjectHandshakeResponse_ReturnsProjectMismatchErrorWhenPathsDiffer()
        {
            JObject response = McpUnitySocketHandler.CreateProjectHandshakeResponse(
                "/Volumes/Shuttle/unity-projects/project-a",
                "/Volumes/Shuttle/unity-projects/project-b");

            Assert.AreEqual("project_mismatch_error", response["error"]?["type"]?.ToString());
            Assert.AreEqual(
                "/Volumes/Shuttle/unity-projects/project-a",
                response["error"]?["details"]?["expectedPath"]?.ToString());
            Assert.AreEqual(
                "/Volumes/Shuttle/unity-projects/project-b",
                response["error"]?["details"]?["actualPath"]?.ToString());
        }

        [Test]
        public void NormalizeProjectPath_NormalizesSeparatorsAndTrailingSlash()
        {
            string normalized = McpUnitySocketHandler.NormalizeProjectPath(
                "\\Volumes\\Shuttle\\unity-projects\\mcp-unity\\");

            Assert.AreEqual("/Volumes/Shuttle/unity-projects/mcp-unity", normalized);
        }

        [Test]
        public void NormalizeProjectPath_PreservesWindowsDriveRoot()
        {
            string normalized = McpUnitySocketHandler.NormalizeProjectPath("C:\\");

            Assert.AreEqual("C:/", normalized);
        }

        [Test]
        public void PathsMatch_SupportsOptionalCaseInsensitiveComparison()
        {
            Assert.IsTrue(McpUnitySocketHandler.PathsMatch(
                "/Volumes/Shuttle/UNITY-PROJECTS/mcp-unity",
                "/Volumes/Shuttle/unity-projects/mcp-unity",
                true));

            Assert.IsFalse(McpUnitySocketHandler.PathsMatch(
                "/Volumes/Shuttle/UNITY-PROJECTS/mcp-unity",
                "/Volumes/Shuttle/unity-projects/mcp-unity",
                false));
        }
    }
}
