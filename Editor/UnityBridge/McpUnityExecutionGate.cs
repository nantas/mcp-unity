namespace McpUnity.Unity
{
    /// <summary>
    /// Phase 1 execution gate that allows only one writer at a time.
    /// </summary>
    public sealed class McpUnityExecutionGate
    {
        private readonly object _sync = new object();
        private string _activeSessionId;
        private string _activeClientName;
        private string _activeOperation;

        public string ActiveClientName
        {
            get
            {
                lock (_sync)
                {
                    return _activeClientName;
                }
            }
        }

        public string ActiveOperation
        {
            get
            {
                lock (_sync)
                {
                    return _activeOperation;
                }
            }
        }

        public bool TryEnterWrite(string sessionId, string clientName, string operationName)
        {
            lock (_sync)
            {
                if (!string.IsNullOrEmpty(_activeSessionId))
                {
                    return false;
                }

                _activeSessionId = sessionId;
                _activeClientName = clientName;
                _activeOperation = operationName;
                return true;
            }
        }

        public void ExitWrite(string sessionId)
        {
            lock (_sync)
            {
                if (_activeSessionId == sessionId)
                {
                    _activeSessionId = null;
                    _activeClientName = null;
                    _activeOperation = null;
                }
            }
        }
    }
}
