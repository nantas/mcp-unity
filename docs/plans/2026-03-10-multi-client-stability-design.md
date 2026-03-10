# MCP Unity Multi-Client Stability Design

## 背景

当前 `mcp-unity` 在同一台机器上存在多个 MCP/CLI 进程时，会因为 Unity 侧的“新连接替换旧连接”策略与 Node 侧自动重连叠加，形成连接互踢和持续重连，进而放大为以下问题：

- WebSocket `closing/sending data` 报错反复刷屏
- 已建立会话被新会话挤掉
- 请求随机超时或失败
- Unity Console 中预期竞争场景被记录为错误

本设计的目标是先完成稳定性止血，再为后续更完整的多 client 调度模型预留演进空间。

## 需求整理

### 已确认目标

- 当前实现采用 `方案 A`，优先解决连接争抢、自动重连放大、日志刷红和写操作冲突失控
- 项目长期规划保留 `方案 C`，后续再演进到显式 job 协议
- 当前实现不引入完整队列，不引入显式 `job_id`
- 允许对返回结构、错误语义和连接处理做温和破坏性调整

### 约束

- 目标场景是同一台机器上的多个 agent/CLI 会话连接同一个 Unity Editor
- Unity Editor 仍然是全局共享状态，不能允许多个写操作并发修改
- 当前阶段读操作尽量直通，写操作必须受统一执行控制
- 当前阶段的设计不能阻碍未来切换到显式 job 模型

## 方案比较

### 方案 A：多连接并存 + 单写互斥

做法：

- 去掉 Unity 侧 `OnOpen()` 中“新连接踢旧连接”的逻辑
- 允许多个 WebSocket client 同时连接
- 为写操作引入 Unity 侧全局执行闸门
- 读操作默认直通
- 写操作在闸门被占用时直接返回 `busy` 类业务错误

优点：

- 改动小，适合快速止血
- 直接切断“互踢 + 自动重连”放大链路
- 可以把“连接失败”和“执行竞争失败”拆成不同语义

缺点：

- 没有全局 FIFO
- 没有任务生命周期模型
- 没有断线补偿查询

结论：

- 作为当前实现目标采用

### 方案 B：Unity 侧权威队列，Node 保持同步外观

做法：

- Unity 侧维护全局 job/queue
- Node 侧默认保持同步请求语义，必要时退化为 job 模式

优点：

- 权威调度点正确
- 比全量 job 化更平滑

缺点：

- 架构复杂度明显高于方案 A
- 仍然属于过渡态，后续可能继续向方案 C 演进

结论：

- 本轮不实现

### 方案 C：全面显式 Job 化

做法：

- 统一收敛为显式 `submit_job / get_job / cancel_job`
- 所有长任务、多 client 调度、断线恢复都围绕 job 生命周期构建

优点：

- 模型最一致
- 最适合长期多 client 调度与可观测性

缺点：

- 对现有协议和调用体验改动最大
- 不适合当前止血目标

结论：

- 作为后续阶段规划保留

## 阶段规划

### 阶段 1：稳定性止血（当前实现）

目标：

- 支持多个 WebSocket client 同时连接同一个 Unity Editor
- 去掉连接互踢与 reconnect ping-pong
- 通过单写互斥保护 Unity 全局状态

范围：

- 多连接并存
- 单写互斥
- 读直通
- `busy` 业务错误
- 日志分级修复

不包含：

- 全局 FIFO
- 显式 job 生命周期
- 断线补偿查询
- client 级公平调度

### 阶段 2：显式 Job 协议（方案 C）

目标：

- 将多 client 调度、断线恢复和长任务语义统一收敛到显式 job 模型

规划方向：

- 引入 `submit_job / get_job / cancel_job`
- 建立稳定的 `queued / running / completed / failed / cancelled` 状态机
- 支持断线后的结果补偿查询
- 为后续 FIFO、公平性和更细粒度调度提供正式承载点

## 阶段 1 设计

### 1. 连接策略

- Unity 侧移除 `McpUnitySocketHandler.OnOpen()` 中关闭旧 session 的逻辑
- 多个 session 可以同时存在，并继续记录到 `McpUnityServer.Clients`
- Node 侧保留现有自动重连能力，但不再因为 Unity 主动替换连接而产生互踢循环
- 当前阶段不引入“连接拒绝”协议，因为目标是允许多连接并存，而不是限制连接数

### 2. 执行策略

- 在 Unity 侧新增全局写执行闸门
- `Write` 与 `CompositeWrite` 请求在执行前必须尝试获取写执行权
- 同一时刻只允许一个写请求执行
- `Read` 请求默认直通，不经过等待或排队
- 当写执行闸门已被占用时，新写请求直接返回 `busy` 类业务错误

当前阶段故意不做“忙时等待”，原因如下：

- 一旦引入等待，本质上就进入了半套 queue/job 模型
- 当前目标是止血，不是交付不完整的调度器
- 明确失败比隐式等待更容易验证和排障

### 3. 读写分类

为避免在 handler 中按方法名硬编码，读写类别应作为类型系统的一部分显式声明。

建议引入的分类：

- `Read`
- `Write`
- `CompositeWrite`

首版挂载口径：

- `McpToolBase` 新增执行类别字段
- `McpResourceBase` 新增执行类别字段，默认值为 `Read`
- `McpUnitySocketHandler` 根据类别决定是否走写执行闸门

首版分类策略：

- tools 默认按 `Write`
- 仅将已确认安全的读取工具标记为 `Read`
- resources 默认按 `Read`
- `batch_execute` 一律按 `CompositeWrite`

首版明确标为 `Read` 的工具：

- `get_gameobject`
- `get_scene_info`

首版明确按 `Write` 或 `CompositeWrite` 处理的典型操作：

- `update_gameobject`
- `update_component`
- `load_scene`
- `save_scene`
- `create_prefab`
- `create_material`
- `select_gameobject`
- `send_console_log`
- `recompile_scripts`
- `batch_execute`

其中 `select_gameobject`、`send_console_log`、`recompile_scripts` 虽然不一定修改 scene 文件，但都会修改 Unity 全局状态，因此不能视为 `Read`。

### 4. 错误语义

阶段 1 需要把“连接故障”和“执行权冲突”明确拆开。

新增业务错误语义：

- 推荐错误类型：`busy_error` 或 `execution_busy`
- 触发条件：写执行闸门已被占用时收到新的 `Write` / `CompositeWrite` 请求

返回方式：

- 通过当前请求的 JSON 响应返回 error
- 不通过关闭 WebSocket 连接表达“忙碌”

推荐最小返回信息：

- `type`
- `message`
- 可选 `retryable: true`
- 可选 `activeOperation`
- 可选 `activeClientName`

### 5. Node 侧行为

Node 侧不负责全局调度，但必须正确区分业务失败和连接失败。

对 `busy` 类响应的处理：

- 直接将错误返回给当前 MCP 调用方
- 不触发 reconnect
- 不调用 `forceReconnect()`
- 不进入本地 `CommandQueue`
- 不清空其他 pending requests

对真正连接故障的处理：

- 保持现有 reconnect / heartbeat / Play Mode close code 逻辑

### 6. 日志分级

建议日志分级如下：

- `Info`
  - client connect/disconnect
  - request accepted
  - write execution acquired/released
- `Warning`
  - 写请求因执行中被拒绝
  - 可恢复的竞争失败
- `Error`
  - 非法 JSON
  - 工具或资源执行异常
  - 非预期 socket 错误

目标是将预期竞争从错误日志中剥离，保留真正需要排查的问题信号。

## 验收标准

### 功能验收

1. 两个及以上 Node/MCP 进程可同时连接同一个 Unity Editor
2. 新连接建立时不会踢掉已有连接
3. 多个空闲连接并存时，不会形成 reconnect ping-pong
4. 同时到达的多个写请求中，只有一个获得执行权
5. 未获得执行权的写请求收到明确 `busy` 类业务错误
6. `batch_execute` 不得绕过单写互斥
7. 读请求在无写冲突时仍可正常执行

### 观测验收

1. Unity Console 中不再因为预期竞争场景持续刷 `Error`
2. Node 收到 `busy` 响应后不会误判为连接坏掉
3. 不再出现由连接互踢触发的大量 `closing/sending data` 报错

## 风险与后续注意事项

- 阶段 1 没有等待队列，写请求高冲突时会以失败暴露给上层调用方
- 当前阶段仍没有断线补偿查询，长任务和超时语义仍然偏粗糙
- 某些看似只读的工具如果未来新增副作用，需要重新评估读写分类
- `batch_execute` 的子操作可能混合读写，因此必须整体纳入单写执行控制

## 结论

- 当前实现采用 `方案 A`，作为稳定性优先的止血方案
- `方案 C` 进入项目后续阶段规划，作为正式长期演进方向
- 阶段 1 的所有实现都应围绕“多连接并存、单写互斥、业务忙碌显式化”展开
