# Requirements Document

## Introduction

AI-Native Team Workspace 是一个面向小型团队的 MVP 协作平台（类 Helio.im），AI 同事与人类成员在同一工作区中共享频道、任务看板与代码会话。本 MVP 基于 Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui + Zustand + Socket.io + Prisma + PostgreSQL + Anthropic SDK + NextAuth.js 构建，采用单工作区硬编码模型，通过自定义 `server.ts` 同时启动 HTTP 服务、Socket.io 实时通道与 Agentic Loop 后台巡检。

平台核心能力包括：

- 统一频道（Channel）与消息流（Message），支持人类与 AI 在同一时间线交流
- 4 列 Kanban 任务看板（Backlog / In Progress / In Review / Done），任务 ID 形如 `PROJ-{N}`
- 角色化 AI 同事（Ada / Hopper），具备完整 Agentic 能力（多轮 tool_use 循环、自主决策、定时巡检）
- AI 在执行高风险动作前发起审批（Approval），等待人类批准后再继续
- 深色优先视觉风格，AI 消息使用紫色渐变徽章与左侧竖线进行视觉区分

本文档以 EARS 格式描述 MVP 的功能性需求与质量需求；明确不在 MVP 范围的项目见末尾"非范围"小节。

## Glossary

- **Workspace**: 单一硬编码工作区，所有用户、频道、任务、审批均隶属于该工作区。
- **System**: 整体平台后端 + 前端组合，作为缺省主语用于全局性需求。
- **Auth_Service**: 基于 NextAuth.js Credentials Provider 的认证子系统，使用 bcrypt 校验密码。
- **Channel_Service**: 处理频道列表、频道消息读写的服务层。
- **Message_Service**: 处理消息持久化、广播与展示的服务层。
- **Task_Service**: 处理任务 CRUD、状态流转与任务 ID 生成的服务层。
- **Approval_Service**: 处理审批创建、批准、拒绝及与 AI Agentic Loop 协同的服务层。
- **AI_Colleague**: `User.isAI = true` 的虚拟成员，具备 `aiRole`（如 `Ada`、`Hopper`），通过角色化 system prompt 驱动。
- **AI_Runtime**: 调用 Anthropic SDK 执行多轮 tool_use 循环、解析工具调用、聚合结果的运行时。
- **Agentic_Loop**: 由进程内 `setInterval` 驱动的后台巡检任务，每 30 秒触发一次，对每个 AI_Colleague 执行一次自主决策周期。
- **Tool**: AI_Runtime 可调用的函数，分为 4 个核心可写工具（`create_task`、`update_task_status`、`request_approval`、`send_channel_message`）与 2 个 mock 只读工具（`mock_web_search`、`mock_read_project_docs`）。
- **Approval**: 由 AI 通过 `request_approval` 工具创建的待人类决策对象，状态为 `PENDING` / `APPROVED` / `REJECTED`。
- **Realtime_Channel**: 基于 Socket.io 的实时事件通道，承载 `message:new`、`task:updated`、`ai:thinking`、`approval:created` 等事件。
- **Kanban_Board**: 任务看板视图，固定 4 列：`Backlog`、`In Progress`、`In Review`、`Done`。
- **Task_ID**: 任务的人类可读标识，格式 `PROJ-{N}`，N 为单调递增整数。
- **AI_Badge**: AI 消息与 AI 任务上的紫色渐变徽章 UI 组件。
- **Dark_Theme**: 深色优先视觉规范，背景 `#0A0A0A`，主色 Indigo `#6366F1`。

## Requirements

### Requirement 1：认证与工作区

**User Story:** As a 团队成员, I want 使用邮箱与密码登录单一工作区, so that 我可以安全地访问与我的身份绑定的频道、任务与 AI 同事。

#### Acceptance Criteria

1. THE Auth_Service SHALL 通过 NextAuth.js Credentials Provider 接受邮箱与密码作为登录凭据。
2. WHEN 用户提交登录表单，THE Auth_Service SHALL 使用 bcrypt 比对数据库中存储的密码哈希。
3. IF 邮箱不存在或 bcrypt 比对失败，THEN THE Auth_Service SHALL 返回认证失败错误并不创建会话。
4. WHEN 认证成功，THE Auth_Service SHALL 建立 NextAuth.js 会话并将用户重定向至 Workspace 主页。
5. WHILE 用户未持有有效会话，THE System SHALL 将对受保护路由的访问重定向至登录页面。
6. THE System SHALL 在数据库初始化（seed）阶段创建 1 个 Workspace、2 至 3 个人类用户与 2 个 AI_Colleague（`Ada`、`Hopper`）。
7. THE System SHALL 将 Workspace 标识硬编码于服务端配置，且 MVP 不提供切换 Workspace 的接口。

### Requirement 2：频道与消息

**User Story:** As a 工作区成员, I want 在共享频道中收发消息, so that 我可以与人类同事和 AI 同事在同一时间线协作。

#### Acceptance Criteria

1. THE Channel_Service SHALL 在用户进入 Workspace 时返回该用户可见的频道列表。
2. WHEN 用户选择某个频道，THE Channel_Service SHALL 按时间正序返回该频道的历史消息。
3. WHEN 用户提交一条消息，THE Message_Service SHALL 将该消息以 `Message` 记录持久化至 PostgreSQL，并将其 `metadata` 字段保存为 JSON。
4. WHEN 一条 `Message` 被持久化，THE Realtime_Channel SHALL 通过 `message:new` 事件向该频道的所有在线订阅者广播该消息。
5. WHERE 消息的发送者 `User.isAI = true`，THE System SHALL 在该消息上携带可被前端识别为 AI 来源的标记。
6. THE Message_Service SHALL 对消息内容长度施加上限 8000 字符。
7. IF 用户提交的消息内容为空字符串或仅包含空白字符，THEN THE Message_Service SHALL 拒绝该消息并返回校验错误。

### Requirement 3：任务看板（Kanban）

**User Story:** As a 工作区成员, I want 在 4 列 Kanban 看板上查看与流转任务, so that 我可以追踪人类与 AI 共同推进的工作。

#### Acceptance Criteria

1. THE Kanban_Board SHALL 呈现固定 4 列：`Backlog`、`In Progress`、`In Review`、`Done`。
2. WHEN 一个新任务被创建，THE Task_Service SHALL 生成形如 `PROJ-{N}` 的 Task_ID，其中 N 为该 Workspace 内单调递增的整数。
3. WHEN 任务被创建，THE Task_Service SHALL 将其默认状态设置为 `Backlog`。
4. WHEN 任务的状态被更新，THE Task_Service SHALL 仅接受目标状态属于上述 4 列之一的请求，并拒绝其他取值。
5. WHEN 任务被创建或更新，THE Realtime_Channel SHALL 通过 `task:updated` 事件向 Workspace 内的订阅者广播任务的最新快照。
6. WHERE 任务由 AI_Colleague 创建或被分配给 AI_Colleague，THE Task_Service SHALL 将 `Task.isAITask` 字段标记为 `true`。
7. THE Kanban_Board SHALL 在任务卡片上显示 Task_ID、标题、负责人头像与（若 `isAITask = true`）AI_Badge。

### Requirement 4：AI 同事与角色化 System Prompt

**User Story:** As a 团队, I want AI 同事以稳定的角色与人格出现在工作区中, so that 团队成员可以预期它们的职责与行为风格。

#### Acceptance Criteria

1. THE System SHALL 为每个 AI_Colleague 在数据库中存储 `isAI = true` 与 `aiRole` 字段。
2. WHEN AI_Runtime 为某个 AI_Colleague 发起一次推理请求，THE AI_Runtime SHALL 将与该 `aiRole` 对应的 system prompt 注入到 Anthropic SDK 调用中。
3. THE System SHALL 在 seed 阶段至少创建两个 AI_Colleague：`Ada` 与 `Hopper`，且二者具备不同的 `aiRole` 与 system prompt。
4. WHEN AI_Colleague 在频道中发送消息，THE Message_Service SHALL 将该消息的发送者关联到对应的 AI 用户记录。
5. WHERE 一条消息的发送者为 AI_Colleague，THE System SHALL 在前端以左侧紫色竖线与紫色渐变 AI_Badge 区分显示该消息。

### Requirement 5：AI 工具调用（Tool Use）

**User Story:** As a AI 同事, I want 通过受限工具集对工作区执行动作, so that 我可以完成任务而不会越过既定边界。

#### Acceptance Criteria

1. THE AI_Runtime SHALL 仅向 Anthropic SDK 暴露以下 6 个工具：`create_task`、`update_task_status`、`request_approval`、`send_channel_message`、`mock_web_search`、`mock_read_project_docs`。
2. WHEN AI_Runtime 收到模型返回的 `tool_use`，THE AI_Runtime SHALL 校验工具名属于上述 6 个之一，并校验参数符合该工具的 schema。
3. IF 模型请求调用未在工具集中的工具，THEN THE AI_Runtime SHALL 拒绝该调用并向模型回写一条错误 `tool_result`。
4. WHERE 被调用的工具为 `mock_web_search` 或 `mock_read_project_docs`，THE AI_Runtime SHALL 仅返回预设的 mock 数据且不对外发起网络请求或读取真实项目文件。
5. WHEN `create_task` 工具被调用，THE Task_Service SHALL 创建一条 `Task` 记录、生成 Task_ID 并广播 `task:updated` 事件。
6. WHEN `update_task_status` 工具被调用，THE Task_Service SHALL 按照 Requirement 3 的状态约束更新任务并广播 `task:updated` 事件。
7. WHEN `send_channel_message` 工具被调用，THE Message_Service SHALL 以该 AI_Colleague 为发送者持久化消息并通过 `message:new` 事件广播。
8. WHEN `request_approval` 工具被调用，THE Approval_Service SHALL 创建一条状态为 `PENDING` 的 Approval 记录并通过 `approval:created` 事件广播。
9. THE AI_Runtime SHALL 在每一轮 `tool_use` 完成后将所有 `tool_result` 回写到下一轮模型上下文中。

### Requirement 6：审批工作流（Approval）

**User Story:** As a 人类成员, I want 在 AI 执行高风险动作前进行审批, so that 我可以保持对工作区变更的控制权。

#### Acceptance Criteria

1. WHEN AI 通过 `request_approval` 工具发起审批，THE Approval_Service SHALL 持久化一条 `Approval` 记录，初始状态为 `PENDING`。
2. THE Approval_Service SHALL 仅接受三种 Approval 状态：`PENDING`、`APPROVED`、`REJECTED`。
3. WHEN 人类用户在 UI 上批准某条 Approval，THE Approval_Service SHALL 将该 Approval 状态更新为 `APPROVED` 并通过 Realtime_Channel 通知关联的 AI_Colleague 继续执行。
4. WHEN 人类用户拒绝某条 Approval，THE Approval_Service SHALL 将该 Approval 状态更新为 `REJECTED` 并通过 Realtime_Channel 通知关联的 AI_Colleague 终止该次决策周期。
5. WHILE 某个 AI_Colleague 存在状态为 `PENDING` 的 Approval，THE Agentic_Loop SHALL 在该轮巡检中跳过该 AI_Colleague 的新一轮决策。
6. WHEN Approval 状态从 `PENDING` 变更为 `APPROVED`，THE AI_Runtime SHALL 在收到通知后立即恢复该 AI_Colleague 的决策周期，而不必等待下一次 30 秒巡检。
7. IF 一条 `PENDING` Approval 在 24 小时后仍未被处理，THEN THE Approval_Service SHALL 将其视为陈旧并在 UI 上显著标注，但不自动改变其状态。

### Requirement 7：Agentic Loop 与多轮 Tool Use

**User Story:** As a 工作区维护者, I want AI 同事以受控的频率自主巡检并采取行动, so that 它们能持续推进工作而不会失控消耗资源。

#### Acceptance Criteria

1. THE Agentic_Loop SHALL 由进程内 `setInterval` 驱动并以 30 秒为间隔触发。
2. WHEN Agentic_Loop 触发一次巡检，THE Agentic_Loop SHALL 对每个未被审批阻塞的 AI_Colleague 启动一次决策周期。
3. THE AI_Runtime SHALL 在单次决策周期内对同一 AI_Colleague 执行最多 5 轮 `tool_use` 循环。
4. IF 单次决策周期内 `tool_use` 轮数达到 5，THEN THE AI_Runtime SHALL 终止该周期并将本次结果记录到日志。
5. WHEN AI_Runtime 构建模型请求上下文，THE AI_Runtime SHALL 在上下文超出预设 token 上限时按时间倒序保留最新内容并截断较早内容。
6. WHEN Agentic_Loop 启动一个 AI_Colleague 的决策周期，THE Realtime_Channel SHALL 在该 AI 思考期间通过 `ai:thinking` 事件向前端广播思考状态。
7. WHEN AI_Colleague 的决策周期结束，THE Realtime_Channel SHALL 通过 `ai:thinking` 事件广播该 AI 已停止思考的状态。
8. THE System SHALL 通过自定义 `server.ts` 同时启动 Next.js HTTP 服务、Socket.io 服务与 Agentic_Loop。

### Requirement 8：实时通信（Socket.io）

**User Story:** As a 工作区成员, I want 在不刷新页面的情况下看到消息、任务与审批的最新变化, so that 我可以与 AI 与人类协作保持同步。

#### Acceptance Criteria

1. THE Realtime_Channel SHALL 基于 Socket.io 提供四类事件：`message:new`、`task:updated`、`ai:thinking`、`approval:created`。
2. WHEN 客户端建立 Socket.io 连接，THE Realtime_Channel SHALL 校验该连接对应的 NextAuth 会话。
3. IF Socket.io 连接缺少有效会话或会话失败，THEN THE Realtime_Channel SHALL 拒绝该连接。
4. WHEN 一条 `Message` 被持久化，THE Realtime_Channel SHALL 在 1 秒内向该频道的所有在线订阅者发送 `message:new` 事件。
5. WHEN 一条 `Task` 被创建或更新，THE Realtime_Channel SHALL 在 1 秒内向 Workspace 内的所有在线订阅者发送 `task:updated` 事件。
6. WHEN 一条 `Approval` 被创建，THE Realtime_Channel SHALL 在 1 秒内向 Workspace 内的所有在线订阅者发送 `approval:created` 事件。
7. WHEN Socket.io 连接断开，THE 客户端 SHALL 尝试自动重连。

### Requirement 9：UI / UX 视觉规范

**User Story:** As a 用户, I want 一致的深色优先视觉与清晰的 AI 视觉区分, so that 我可以在视觉上立即识别 AI 与人类的输出。

#### Acceptance Criteria

1. THE System SHALL 默认采用 Dark_Theme：背景 `#0A0A0A`，主色 Indigo `#6366F1`。
2. WHERE 一条消息的发送者为 AI_Colleague，THE System SHALL 在该消息左侧渲染紫色竖线，并在头像或昵称旁渲染紫色渐变 AI_Badge。
3. WHERE 一个任务卡片的 `isAITask = true`，THE System SHALL 在该任务卡片上渲染紫色渐变 AI_Badge。
4. THE System SHALL 在所有时间显示位置使用 `date-fns` 计算的相对时间（例如"3 minutes ago"）。
5. THE System SHALL 使用 shadcn/ui 组件作为基础 UI 组件库并通过 Tailwind 实施视觉规范。
6. WHEN 客户端组件管理跨视图的共享状态，THE System SHALL 通过 Zustand store 管理该状态。

### Requirement 10：错误处理、重试与日志

**User Story:** As a 维护者, I want AI 调用具有有界的重试与可观测的错误日志, so that 临时故障不会导致 AI 同事失控或静默失败。

#### Acceptance Criteria

1. WHEN AI_Runtime 对 Anthropic SDK 的请求失败，THE AI_Runtime SHALL 以指数退避策略最多重试 3 次。
2. IF AI_Runtime 在 3 次重试后仍未成功，THEN THE AI_Runtime SHALL 终止该次决策周期并将失败原因写入服务端日志。
3. WHEN 工具调用因参数 schema 校验失败，THE AI_Runtime SHALL 向模型回写包含失败原因的 `tool_result` 而不是抛出未处理异常。
4. IF 数据库写入失败（消息、任务、审批），THEN 对应的服务层 SHALL 向调用方返回错误，且 Realtime_Channel SHALL 不广播未持久化的事件。
5. THE System SHALL 在服务端记录每个 AI 决策周期的开始时间、结束时间、轮数与最终结果摘要。
6. IF Agentic_Loop 的某次巡检抛出未捕获异常，THEN THE Agentic_Loop SHALL 捕获并记录该异常，且不终止后续巡检的调度。

## 非范围（Out of Scope for MVP）

以下能力明确不在本 MVP 范围内，仅作记录以便对齐预期：

- 多 Workspace 切换与 Workspace 创建流
- 成员邀请、角色权限分级与组织管理
- 真实第三方集成（如 GitHub、Slack、Linear）
- 文件上传与附件存储
- 全文消息搜索
- 任务卡片拖拽排序（可作为 nice-to-have，不属于核心验收）
- 基于 Redis / Bull 的分布式任务队列（MVP 仅使用进程内 `setInterval`）
