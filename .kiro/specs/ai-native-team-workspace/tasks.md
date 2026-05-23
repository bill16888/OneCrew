# Implementation Plan: AI-Native Team Workspace

## Overview

按 9 步顺序构建 MVP：先打基础（Prisma + UI 骨架），再接通实时与认证（server.ts + Socket.io + NextAuth），随后接入 AI Runtime 与 6 个工具，再叠加审批阻塞与即时唤醒，最后启动 Agentic Loop 并打磨 UI / 日志。每个核心实现任务都附带 fast-check 属性测试，对应设计文档中的 29 条 Correctness Properties。

任务根据 design.md 的 Property 编号与 requirements.md 的子条目编号双向追溯。所有标记为 `*` 的子任务为可选测试任务。

## Tasks

- [x] 1. Prisma Schema + Seed
  - [x] 1.1 初始化 Next.js 14 + TypeScript + Tailwind + shadcn/ui 骨架
    - 初始化 App Router 项目；安装 prisma、@prisma/client、next-auth、bcryptjs、socket.io、socket.io-client、@anthropic-ai/sdk、zustand、zod、date-fns、pino、fast-check、vitest、@testing-library/react
    - 配置 Tailwind 暗色主题 token（背景 `#0A0A0A`、Indigo `#6366F1`、紫色 AI Badge 渐变）
    - _Requirements: 9.1, 9.5_
  - [x] 1.2 定义 Prisma schema（Workspace / User / Channel / Message / Task / Approval）
    - `prisma/schema.prisma`：`Workspace.taskCounter`、`User.isAI` + `User.aiRole`、枚举 `TaskStatus` 与 `ApprovalStatus`、必要索引
    - 运行 `prisma migrate dev` 生成客户端
    - _Requirements: 1.6, 3.1, 3.6, 6.2_
  - [x] 1.3 实现 seed 脚本
    - `prisma/seed.ts`：创建 1 个 Workspace、2-3 个人类用户（bcrypt 哈希）、2 个 AI（`Ada`、`Hopper`，`isAI=true`、`passwordHash=null`、`aiRole` 不同）、`#general` 与 `#engineering` 频道
    - _Requirements: 1.6, 4.1, 4.3_
  - [x]* 1.4 Seed 一致性 smoke 测试
    - 断言种子产出的人类/AI 用户数量、`isAI` 标记、`aiRole` 取值与默认频道
    - _Requirements: 1.6, 4.1, 4.3_

- [x] 2. 静态 UI 框架
  - [x] 2.1 实现根布局、暗色主题 token、Zustand store
    - `app/layout.tsx`、`app/globals.css`（背景 `#0A0A0A`）
    - `store/useWorkspaceStore.ts`：`currentChannelId`、`thinkingAIs`、审批弹窗状态
    - _Requirements: 9.1, 9.5, 9.6_
  - [x] 2.2 实现 `/login` 页面骨架
    - 邮箱 + 密码字段、提交按钮、错误信息占位
    - _Requirements: 1.1, 1.4_
  - [x] 2.3 实现 `(workspace)` 布局与频道侧边栏
    - 侧边栏列出频道并跳转 `/channels/[channelId]` 与 `/board`
    - _Requirements: 2.1, 3.1_
  - [x] 2.4 实现频道页与消息组件
    - `components/channel/MessageRow.tsx`：AI 消息左侧紫色竖线 + AI Badge
    - `components/channel/MessageComposer.tsx`、`components/ui/AIBadge.tsx`
    - `app/(workspace)/channels/[channelId]/page.tsx` 静态布局
    - _Requirements: 4.5, 9.2_
  - [x] 2.5 实现 4 列 Kanban 看板与任务卡片
    - `components/board/KanbanBoard.tsx`：固定 `Backlog` / `In Progress` / `In Review` / `Done`
    - `components/board/TaskCard.tsx`：Task_ID、标题、负责人头像、`isAITask` 时显示 AI Badge
    - _Requirements: 3.1, 3.7, 9.3_
  - [x] 2.6 实现审批弹窗组件
    - `components/approval/ApprovalDialog.tsx`：列出 PENDING 审批，提供批准/拒绝按钮
    - _Requirements: 6.1, 6.3, 6.4_
  - [x]* 2.7 编写 UI 单元测试
    - 验证 KanbanBoard 渲染恰好 4 列；TaskCard 在 `isAITask=true` 时渲染 AI Badge；MessageRow 对 AI 发送者渲染紫色竖线
    - _Requirements: 3.1, 3.7, 4.5, 9.2, 9.3_

- [x] 3. server.ts + Socket.io + 消息 API
  - [x] 3.1 实现 Prisma 客户端单例
    - `lib/prisma.ts`
    - _Requirements: 1.6_
  - [x] 3.2 定义实时事件常量
    - `lib/realtime/events.ts`：`message:new` / `task:updated` / `ai:thinking` / `approval:created`
    - _Requirements: 8.1_
  - [x] 3.3 实现 Socket.io 服务端（先用占位会话校验）
    - `lib/realtime/io.ts`：绑定 httpServer；连接时自动 `socket.join('workspace:{WORKSPACE_ID}')`；监听 `subscribe:channel` 加入频道房间
    - 此处使用占位中间件，真正的 NextAuth 会话校验在 4.5 替换
    - _Requirements: 8.1_
  - [x] 3.4 实现 ChannelService
    - `lib/services/channel.service.ts`：`listByWorkspace`、`getMessages`（按 `createdAt` 升序）
    - _Requirements: 2.1, 2.2_
  - [x] 3.5 实现 MessageService（持久化、校验、广播、AI 来源标记）
    - `lib/services/message.service.ts`：`create`（拒绝空白内容与 >8000 字符）、`listByChannel`
    - 持久化成功后向 `channel:{channelId}` 广播 `message:new`，载荷携带 `fromAI = sender.isAI`
    - 持久化失败时 **不** 广播
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 4.4, 8.4, 10.4_
  - [x] 3.6 实现 `/api/messages` POST 与 `/api/channels` GET
    - `app/api/messages/route.ts`、`app/api/channels/route.ts`
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 3.7 实现 `server.ts` 入口
    - `createServer` 包裹 Next.js handler、绑定 Socket.io、调用 `httpServer.listen`
    - _Requirements: 7.8, 8.1_
  - [x] 3.8 实现客户端 Socket.io provider（自动重连）
    - `lib/realtime/client.ts`：默认 `reconnection: true`；订阅 `subscribe:channel`
    - _Requirements: 8.7_
  - [x] 3.9 将频道页接入实时数据流
    - 订阅 `message:new` 追加消息；composer 通过 `/api/messages` POST
    - _Requirements: 2.3, 2.4, 4.5_
  - [x]* 3.10 属性测试：频道消息按时间正序返回
    - **Property 2: 频道消息按时间正序返回**
    - **Validates: Requirements 2.2**
  - [x]* 3.11 属性测试：消息持久化—广播一致性
    - **Property 3: 消息持久化—广播一致性**
    - **Validates: Requirements 2.3, 2.4, 8.4, 10.4**
  - [x]* 3.12 属性测试：AI 来源标记
    - **Property 4: AI 来源标记**
    - **Validates: Requirements 2.5, 4.4**
  - [x]* 3.13 属性测试：消息内容校验
    - **Property 5: 消息内容校验**
    - **Validates: Requirements 2.6, 2.7**
  - [x]* 3.14 属性测试：实时延迟上限
    - **Property 26: 实时延迟上限**
    - **Validates: Requirements 8.4, 8.5, 8.6**

- [x] 4. NextAuth Credentials + bcrypt + middleware
  - [x] 4.1 实现 NextAuth options（Credentials + bcrypt）
    - `lib/auth/options.ts`：`session.strategy = 'jwt'`，`authorize` 中拒绝 `isAI=true` 用户与缺失 `passwordHash`，`callbacks` 注入 `uid`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 4.2 挂载 `/api/auth/[...nextauth]` 路由
    - `app/api/auth/[...nextauth]/route.ts`
    - _Requirements: 1.1, 1.4_
  - [x] 4.3 将 `/login` 页面接入 `signIn()` 与错误反馈
    - 失败时停留在登录页并显示错误，成功后跳转工作区主页
    - _Requirements: 1.1, 1.3, 1.4_
  - [x] 4.4 实现 `middleware.ts` 受保护路由守卫
    - 放行 `/login` 与 `/api/auth/*`，其余路径未登录时 302 至 `/login`
    - _Requirements: 1.5_
  - [x] 4.5 用真实 NextAuth 会话校验替换 Socket.io 占位中间件
    - 解析握手 cookie 中的 NextAuth session token；无效会话立即 `next(new Error('unauthenticated'))`，不加入任何房间
    - _Requirements: 8.2, 8.3_
  - [x]* 4.6 属性测试：bcrypt 双向认证正确性
    - **Property 1: 认证基于 bcrypt 的双向正确性**
    - **Validates: Requirements 1.2, 1.3**
  - [x]* 4.7 属性测试：Socket.io 会话校验
    - **Property 25: Socket.io 会话校验**
    - **Validates: Requirements 8.2, 8.3**

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. AI Runtime + 6 工具 schema + dispatcher + 多轮循环 + 重试
  - [x] 6.1 实现 Ada / Hopper system prompts
    - `lib/ai/prompts.ts`：导出 `SYSTEM_PROMPTS` 按 `aiRole` 索引
    - _Requirements: 4.2, 4.3_
  - [x] 6.2 实现 6 个工具的 schema、Zod 校验与 dispatcher 入口
    - `lib/ai/tools/index.ts`：`TOOL_DEFINITIONS`（恰好 6 项）、`TOOL_NAMES`、`TOOL_ZOD_SCHEMAS`、`dispatchTool`
    - `dispatchTool` 永不抛出：未知工具或 schema 校验失败时回写 `is_error: true` 的 `tool_result`
    - 各工具的实际副作用分支留作 TODO，由步骤 7 / 9 接入
    - _Requirements: 5.1, 5.2, 5.3, 10.3_
  - [x] 6.3 实现 Anthropic 调用重试（指数退避，最多 3 次重试）
    - `lib/ai/anthropic.ts`：`callAnthropicWithRetry`（首次 + 3 次重试 = 最多 4 次尝试，500ms→1s→2s 抖动）
    - _Requirements: 10.1, 10.2_
  - [x] 6.4 实现上下文截断
    - `lib/ai/context.ts`：`trimContextToTokenBudget` 返回原 messages 的连续后缀，估算 token 数 ≤ budget
    - _Requirements: 7.5_
  - [x] 6.5 实现多轮 tool_use 循环 `runCycle`（上限 5 轮 + finishReason + 结构化日志 + ai:thinking）
    - `lib/ai/runtime.ts`：构建上下文 → `callAnthropicWithRetry` → 解析 `tool_use` → 通过 `dispatchTool` 收集 `tool_result` → 全部回写到下一轮 `user` 消息；包装在 `ai:thinking{state:true/false}` 之间
    - 注入对应 `aiRole` 的 system prompt；`finishReason` ∈ `'stop' | 'round_cap' | 'retry_exhausted' | 'rejected'`
    - _Requirements: 4.2, 5.9, 7.3, 7.4, 7.6, 7.7, 10.5_
  - [x]* 6.6 属性测试：角色化 system prompt 注入
    - **Property 11: 角色化 system prompt 注入**
    - **Validates: Requirements 4.2**
  - [x]* 6.7 属性测试：工具表面恒等
    - **Property 12: 工具表面恒等**
    - **Validates: Requirements 5.1**
  - [x]* 6.8 属性测试：工具调度全函数性
    - **Property 13: 工具调度的全函数性**
    - **Validates: Requirements 5.2, 5.3, 10.3**
  - [x]* 6.9 属性测试：tool_result 完整回写
    - **Property 17: tool_result 完整回写**
    - **Validates: Requirements 5.9**
  - [x]* 6.10 属性测试：多轮上限与终止原因
    - **Property 22: 多轮上限与终止原因**
    - **Validates: Requirements 7.3, 7.4**
  - [x]* 6.11 属性测试：上下文截断保留尾部
    - **Property 23: 上下文截断保留尾部**
    - **Validates: Requirements 7.5**
  - [x]* 6.12 属性测试：重试上限
    - **Property 28: 重试上限**
    - **Validates: Requirements 10.1, 10.2**

- [x] 7. 4 核心工具落地 + 2 mock 工具
  - [x] 7.1 实现 TaskService（PROJ-{N} 单调 ID + 状态值域 + isAITask 派生 + 广播）
    - `lib/services/task.service.ts`：`create` 在事务内 `UPDATE workspace.taskCounter` 自增并写入 `taskId`；`status` 默认 `Backlog`；`updateStatus` 仅接受 4 个枚举值；`isAITask = creator.isAI || (assignee?.isAI ?? false)`；提交后广播 `task:updated`
    - 持久化失败时 **不** 广播
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 5.5, 5.6, 8.5, 10.4_
  - [x] 7.2 接入 `create_task` / `update_task_status` / `send_channel_message` 三个核心可写工具分支
    - 修改 `lib/ai/tools/index.ts`：`create_task` → `TaskService.create`；`update_task_status` → `TaskService.updateStatus`；`send_channel_message` → `MessageService.create({ userId: aiUserId })`
    - 每个分支返回精简的 `tool_result` 文本（成功消息或错误描述）
    - _Requirements: 4.4, 5.5, 5.6, 5.7_
  - [x] 7.3 实现 2 个 mock 只读工具
    - `lib/ai/tools/mocks.ts`：`mock_web_search`、`mock_read_project_docs` 返回确定性预设载荷；**不** 调用 `fetch` 或 `fs`
    - _Requirements: 5.4_
  - [x] 7.4 实现 `/api/tasks` GET 路由
    - `app/api/tasks/route.ts` 提供看板读取数据
    - _Requirements: 3.1, 3.7_
  - [x]* 7.5 属性测试：Task ID 单调递增且唯一
    - **Property 6: Task ID 单调递增且唯一**
    - **Validates: Requirements 3.2**
  - [x]* 7.6 属性测试：新任务默认 Backlog
    - **Property 7: 新任务默认 Backlog**
    - **Validates: Requirements 3.3**
  - [x]* 7.7 属性测试：状态更新值域
    - **Property 8: 状态更新值域**
    - **Validates: Requirements 3.4, 5.6**
  - [x]* 7.8 属性测试：任务创建/更新—广播一致性
    - **Property 9: 任务创建/更新—广播一致性**
    - **Validates: Requirements 3.5, 5.5, 5.6, 8.5, 10.4**
  - [x]* 7.9 属性测试：isAITask 派生
    - **Property 10: isAITask 派生自参与者**
    - **Validates: Requirements 3.6**
  - [x]* 7.10 属性测试：Mock 工具的纯净性
    - **Property 14: Mock 工具的纯净性**
    - **Validates: Requirements 5.4**
  - [x]* 7.11 属性测试：send_channel_message 发送者归属
    - **Property 15: send_channel_message 工具的发送者归属**
    - **Validates: Requirements 5.7, 4.4**

- [x] 8. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. 审批工作流 + EventEmitter
  - [x] 9.1 实现 agenticEmitter 单例
    - `lib/loop/emitter.ts`：导出 `EventEmitter`，承载 `wakeup` / `reject` 通道
    - _Requirements: 6.6, 7.2_
  - [x] 9.2 实现 ApprovalService（create / approve / reject / listPendingForAI / isStale + 广播）
    - `lib/services/approval.service.ts`：`create` 持久化 `PENDING` 并广播 `approval:created`；`approve` 切到 `APPROVED` 后 `agenticEmitter.emit('wakeup', aiUserId)`；`reject` 切到 `REJECTED`（不发 wakeup）；`isStale(now)` 判断 `now - createdAt > 24h`；持久化失败不广播
    - _Requirements: 5.8, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 8.6, 10.4_
  - [x] 9.3 接入 `request_approval` 工具分支
    - 修改 `lib/ai/tools/index.ts`：`request_approval` → `ApprovalService.create({ aiUserId, action, payload })`
    - _Requirements: 5.8, 6.1_
  - [x] 9.4 实现 `/api/approvals/[id]` PATCH 路由
    - `app/api/approvals/[id]/route.ts` 处理批准 / 拒绝
    - _Requirements: 6.3, 6.4_
  - [x] 9.5 将 ApprovalDialog 接入实时事件与 PATCH API
    - 订阅 `approval:created` 弹出审批；调用 PATCH 确认；对 `isStale` 为真的审批显著标注
    - _Requirements: 6.1, 6.3, 6.4, 6.7_
  - [x]* 9.6 属性测试：审批创建—广播一致性
    - **Property 16: 审批创建—广播一致性**
    - **Validates: Requirements 5.8, 6.1, 8.6, 10.4**
  - [x]* 9.7 属性测试：审批状态值域
    - **Property 18: 审批状态值域**
    - **Validates: Requirements 6.2**
  - [x]* 9.8 属性测试：拒绝终止当轮周期
    - **Property 20: 拒绝终止当轮周期**
    - **Validates: Requirements 6.4**
  - [x]* 9.9 属性测试：陈旧审批检测
    - **Property 21: 陈旧审批检测**
    - **Validates: Requirements 6.7**

- [x] 10. Agentic Loop（setInterval 30s + ai:thinking）
  - [x] 10.1 实现 AgenticLoop（30s setInterval + inFlight 防并发 + PENDING 阻塞 + EventEmitter 即时唤醒）
    - `lib/loop/agentic-loop.ts`：每 30s 遍历 AI 用户，存在 `PENDING` 审批则跳过；`runForAI` 受 `inFlight` 集合保护
    - 订阅 `agenticEmitter.on('wakeup', aiUserId)` 立即触发 `runForAI` 而不等下一次 tick
    - 顶层 `tick()` 与每个 `runForAI` 各自 try/catch；异常仅记录日志，不终止后续调度
    - _Requirements: 6.5, 6.6, 7.1, 7.2, 7.6, 7.7, 10.6_
  - [x] 10.2 在 `server.ts` 启动序列中接入 `AgenticLoop.start(io)`
    - 在 Socket.io 中间件注册之后启动；进程退出前 `AgenticLoop.stop()` 清理 timer
    - _Requirements: 7.8_
  - [x]* 10.3 属性测试：审批阻塞与即时唤醒（Agentic 门控）
    - **Property 19: 审批阻塞与即时唤醒（Agentic 门控）**
    - **Validates: Requirements 6.3, 6.5, 6.6, 7.2**
  - [x]* 10.4 属性测试：ai:thinking 配对广播
    - **Property 24: ai:thinking 配对广播**
    - **Validates: Requirements 7.6, 7.7**
  - [x]* 10.5 属性测试：tick 异常隔离
    - **Property 29: tick 异常隔离**
    - **Validates: Requirements 10.6**

- [x] 11. UI 打磨 + 错误日志
  - [x] 11.1 实现 `<TimeAgo />` 组件
    - `components/ui/TimeAgo.tsx`：使用 `date-fns` 的 `formatDistanceToNow(d, { addSuffix: true })`
    - _Requirements: 9.4_
  - [x] 11.2 打磨 AI 消息视觉与 AI Badge 渐变一致性
    - 复核 MessageRow 紫色竖线、AI Badge 渐变、TaskCard 上的 AI 标记符合 Dark_Theme 规范
    - _Requirements: 4.5, 9.2, 9.3_
  - [x] 11.3 接入结构化日志
    - `lib/logger.ts`：基于 pino；`runCycle` 输出 `aiUserId` / `rounds` / `finishReason` / `durationMs`；服务层错误与 tick 异常统一进入日志
    - _Requirements: 10.5_
  - [x] 11.4 在 UI 上呈现思考状态与陈旧审批
    - 订阅 `ai:thinking` 在 AI 头像旁显示思考态；审批 `isStale` 时在弹窗 / 列表上显著标注
    - _Requirements: 6.7, 7.6, 7.7_
  - [x]* 11.5 属性测试：相对时间渲染
    - **Property 27: 相对时间渲染**
    - **Validates: Requirements 9.4**

- [x] 12. 最终 Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标记 `*` 的子任务为可选属性测试 / 单元测试，可在 MVP 阶段跳过；其余子任务必须实现。
- 每个属性测试对应 design.md 中编号一致的 Correctness Property，并在任务行内标注其验证的 Requirements 子条目。
- 审批阻塞与即时唤醒由 `agenticEmitter` 串联：`ApprovalService.approve` → `emit('wakeup')` → `AgenticLoop.runForAI`，保证从 `PENDING → APPROVED` 立即推进 AI，而 `REJECTED` 不发 wakeup。
- 工具集恒为 6 项；未知工具与参数 schema 失败均以 `is_error: true` 的 `tool_result` 回写，不抛出异常。
- 实时广播仅在服务层持久化成功后触发；DB 失败时静默不广播（覆盖于 Properties 3 / 9 / 16）。
- 同一文件不会在同一波被并行修改：`lib/ai/tools/index.ts` 在 6.2 / 7.2 / 9.3 三波依次扩展；`lib/realtime/io.ts` 在 3.3 / 4.5 两波；`server.ts` 在 3.7 / 10.2 两波；`/login` 页面在 2.2 / 4.3 两波。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.3", "3.1", "3.2"] },
    { "id": 3, "tasks": ["1.4", "2.4", "2.5", "2.6", "3.3", "3.4", "6.1", "6.4"] },
    { "id": 4, "tasks": ["2.7", "3.5", "3.7", "3.8", "4.1", "6.2", "6.3", "7.1", "7.3", "9.1"] },
    { "id": 5, "tasks": ["3.6", "4.2", "4.4", "4.5", "6.5", "7.2", "9.2"] },
    { "id": 6, "tasks": ["3.9", "4.3", "7.4", "9.3", "9.4", "3.10", "3.11", "3.12", "3.13", "3.14", "4.6", "4.7", "6.6", "6.7", "6.8", "6.9", "6.10", "6.11", "6.12", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10", "7.11"] },
    { "id": 7, "tasks": ["9.5", "9.6", "9.7", "9.8", "9.9", "10.1", "11.1", "11.3"] },
    { "id": 8, "tasks": ["10.2", "10.3", "10.4", "10.5", "11.2", "11.4", "11.5"] }
  ]
}
```
