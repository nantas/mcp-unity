using Newtonsoft.Json.Linq;
using NUnit.Framework;
using McpUnity.Resources;
using McpUnity.Tools;
using McpUnity.Unity;

namespace McpUnity.Tests
{
    public class McpOperationKindTests
    {
        private sealed class FakeTool : McpToolBase
        {
            public FakeTool()
            {
                Name = "fake_tool";
            }

            public override JObject Execute(JObject parameters)
            {
                return new JObject();
            }
        }

        private sealed class FakeResource : McpResourceBase
        {
            public FakeResource()
            {
                Name = "fake_resource";
                Uri = "unity://fake";
            }

            public override JObject Fetch(JObject parameters)
            {
                return new JObject();
            }
        }

        [Test]
        public void ToolBase_DefaultsToWrite()
        {
            Assert.AreEqual(McpOperationKind.Write, new FakeTool().OperationKind);
        }

        [Test]
        public void ResourceBase_DefaultsToRead()
        {
            Assert.AreEqual(McpOperationKind.Read, new FakeResource().OperationKind);
        }

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
            Assert.AreEqual(McpOperationKind.CompositeWrite, new BatchExecuteTool(null).OperationKind);
        }
    }
}
