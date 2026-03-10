namespace McpUnity.Unity
{
    /// <summary>
    /// Declares whether an MCP operation only reads state or requires single-writer admission.
    /// </summary>
    public enum McpOperationKind
    {
        Read,
        Write,
        CompositeWrite
    }
}
