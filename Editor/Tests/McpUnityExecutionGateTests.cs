using NUnit.Framework;
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
    }
}
