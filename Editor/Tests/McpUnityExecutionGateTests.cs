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
    }
}
