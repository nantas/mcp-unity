# MCP Unity Transport Stability (Phase 1+2) Design

**Date:** 2026-03-25
**Scope:** 仅覆盖 Phase 1（稳定性热修）+ Phase 2（超时策略分层）

## 1. 背景与问题定义

用户侧反馈的核心症状是：
- `Transport closed`
- 请求超时（尤其是编辑器刷新、重编译、PlayMode 切换、长写操作后）
- 偶发“连接恢复了但请求已经失败”

当前仓库中，这些症状来自多个因素叠加，而不是单点故障。

## 2. 现状核对（与代码一致）

### 2.1 生命周期断连语义不完整
- Unity 仅定义 `PlayMode=4001`。
- `OnBeforeAssemblyReload()` 仍调用 `StopServer()`（无专用 code）。
- Node 只识别 `4001` 进入快速重连；Assembly reload 被当作普通断连。

**影响：** Node 无法区分“预期短断连”与“真实故障”。

### 2.2 Node 请求失败策略过于激进
- `mcpUnity.ts` 中 `connection.on('error')` 直接 `rejectAllPendingRequests()`。
- 这会让瞬时网络错误/生命周期切换提前终止 in-flight 请求。

**影响：** 明明可自动重连，但请求已被提前 fail，表现为频繁超时或 transport error。

### 2.3 超时策略过粗
- 默认请求超时仍为 10 秒（Unity 与 Node fallback 一致）。
- `sendRequestInternal` 超时后立即 `forceReconnect()`。
- 大量编辑器工作流（测试、重编译、菜单触发刷新）天然超过 10 秒。

**影响：** 正常慢操作被判失败，随后又触发重连，放大不稳定感。

### 2.4 额外发现：`connect()` 早期失败场景存在 Promise 悬空风险
- `unityConnection.ts` 在 `onclose` 里先切状态再判断是否 reject 初次 connect Promise。
- 某些快速失败路径下，`connect()` 可能既不 resolve 也不 reject。

**影响：** 上层调用被卡住并最终呈现为请求超时。

## 3. 目标与非目标

### 3.1 目标
- 将“Unity 生命周期导致的短断连”转化为可恢复事件，而非请求级雪崩失败。
- 降低误判超时，减少无意义重连。
- 保持现有项目亲和握手（project-affinity）与单写者并发策略不变。

### 3.2 非目标
- 不引入跨生命周期的 Unity 任务持久化（这属于后续协议升级）。
- 不改为全局写队列/事务调度。
- 不弱化 `project_mismatch_error` 与 `busy_error` 语义。

## 4. 方案设计

## 4.1 Phase 1：稳定性热修

### A. 补齐 Assembly Reload 生命周期 close code

**变更：**
- Unity 新增 `UnityCloseCode.AssemblyReload = 4002`。
- `OnBeforeAssemblyReload()` 改为：
  - `StopServer(UnityCloseCode.AssemblyReload, "Unity assembly reload")`
- Node `UnityCloseCode` 同步新增 `ASSEMBLY_RELOAD = 4002`。
- Node 将 `4002` 与 `4001` 同等视为“生命周期重连模式”（快速轮询）。

**收益：**
- Node 可准确识别预期短断连，减少误诊为 transport failure。

### B. 调整连接错误与 pending 请求失败边界

**变更：**
- `mcpUnity.ts` 中，`connection.on('error')` 不再触发 `rejectAllPendingRequests()`。
- `on('error')` 仅记录与分类连接错误，由状态机决定是否最终失败。
- pending 请求失败条件收敛为：
  - 请求级 timeout 触发；或
  - 连接进入终态 `Disconnected` 且无重连路径（如重连预算耗尽）。

**收益：**
- 给自动重连和请求超时机制留出恢复窗口，避免“过早失败”。

### C. 修复 `connect()` Promise 早期失败悬空

**变更：**
- 在 `doConnect()` 中引入“是否初始连接阶段”的稳定判定（避免受状态改写影响）。
- 当初始连接在 `onopen` 前收到 `onclose` 时，必须确定性 reject。

**收益：**
- 避免上层 await 卡死并演化为外层超时。

## 4.2 Phase 2：超时策略分层

### A. 拆分连接超时与请求超时

**变更：**
- `UnityConnectionConfig` 新增 `connectTimeout`（默认 10s）。
- `requestTimeout` 专用于业务请求生命周期。
- `mcpUnity.ts` 维护两个值：
  - `connectTimeout = 10000ms`（固定默认）
  - `requestTimeout = 60000ms`（默认）

**收益：**
- 避免用请求超时误驱动底层 socket connect 超时。

### B. 提升默认请求超时并同步配置契约

**变更：**
- Unity 设置默认最小值从 10s 提升到 60s。
- Node 在无配置文件 fallback 情况默认 60s。

**收益：**
- 适配 Unity Editor 的真实工作负载。

### C. 为已知慢工具设置 per-request timeout

**首批工具：**
- `run_tests`
- `recompile_scripts`
- `execute_menu_item`

**策略：**
- 统一使用 `LONG_RUNNING_TIMEOUT_MS = 120000`。
- 调用 `mcpUnity.sendRequest(..., { timeout: LONG_RUNNING_TIMEOUT_MS })`。

**收益：**
- 在不全局放大等待时间的前提下，减少慢工具误超时。

### D. 减少超时后的重连放大

**变更：**
- 请求超时后仅在连接仍处于 `Connected` 时才触发 `forceReconnect()`。
- 若已处于 `Reconnecting/Disconnected`，不额外触发强制重连。

**收益：**
- 防止重连风暴和重复连接抖动。

## 5. 状态机与失败策略（目标行为）

- `connection error`：记录 + 等待状态机；不直接失败所有 pending。
- `close code = 4001/4002`：进入生命周期快速轮询重连。
- `pending request`：
  - 在重连窗口内保留；
  - 到 request timeout 再失败；
  - 若系统进入终态 `Disconnected`（不可恢复）统一失败。
- `busy_error`：保持业务错误语义，不触发 transport 级重连。

## 6. 风险与兼容性

### 6.1 主要风险
- 请求保留时间更长，可能增加 pending map 生命周期。
- 提升默认超时后，真正故障的“显性失败时间”延后。

### 6.2 缓解措施
- 依旧保留请求级 timeout 上限。
- 增加日志分类（生命周期断连、超时、终态断连）以可观测化。

### 6.3 兼容性
- 对外 MCP 工具名与参数协议不变。
- `busy_error` / `project_mismatch_error` 语义不变。
- 仅提升默认行为稳定性，不改变业务能力边界。

## 7. 验证标准（通过门槛）

1. Assembly reload 后，后续请求无需手工重启 MCP 即可恢复。
2. PlayMode 进出期间使用快速轮询重连，恢复后请求可用。
3. `run_tests/recompile_scripts/execute_menu_item` 在 10~120 秒区间不应被误判超时。
4. 并发写冲突仍返回 `busy_error`，不演化为 transport failure。
5. 连接首次快速失败路径不出现“请求挂死无返回”。

## 8. 交付顺序

1. 先完成 Phase 1（生命周期语义 + 失败边界 + connect 悬空修复）。
2. 再完成 Phase 2（超时分层 + 默认值提升 + 慢工具覆盖）。
3. 最后补文档与回归用例矩阵。
