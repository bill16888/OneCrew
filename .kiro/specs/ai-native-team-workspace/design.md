# Design Document

## Overview

AI-Native Team Workspace 的 MVP 在**单进程**内同时承载 Next.js 14 (App Router) HTTP 服务、Socket.io 实时通道与 Agentic Loop 后台巡检。整个系统由 `server.ts` 作为唯一入口启动，避免引入消息队列与多进程协调，从而把复杂度集中在三个清晰的层次：

1. **应用层**（`app/`、`components/`、`store/`）：Next.js + React Server Components + Tailwind + shadcn/ui + Zustand，承担渲染与交互。
2. **服务层**（`lib/services/*`）：纯 TypeScript 模块，封装认证、频道、消息、任务、审批等领域逻辑。所有写操作都经过此层，便于单元测试。
3. **运行时层**（`lib/ai/*`、`lib/realtime/*`、`lib/loop/*`）：AI Runtime（Anthropic SDK 调用 + 工具调度 + 多轮循环 + 重试）、Realtime（Socket.io 服务端 + NextAuth 会话校验）、Agentic Loop（30 秒 `setInterval` + `EventEmitter` 唤醒）。

设计目标：

- 单一硬编码 Workspace，省去多租户复杂度。
- AI 行为通过**受限工具集**（6 个）和**多轮上限**（5 轮）/**重试上限**（3 次指数退避）实现"有界自主"。
- 审批阻塞机制保证人类对高风险动作有最终决策权；`PENDING` 阻塞、`APPROVED` 即时唤醒、`REJECTED` 终止当轮决策周期。
- 服务层与 Realtime/AI Runtime 解耦：Realtime 只在持久化成功后广播，AI Runtime 只通过服务层落地副作用。

## Architecture

### 进程拓扑（单进程 server.ts）

```
┌─────────────────────────────────────────────────────────────────────┐
│                            server.ts                                │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────────┐   │
│  │ Next.js HTTP │   │ Socket.io Server │   │ Agentic Loop       │   │
│  │ (App Router) │◄──┤ (NextAuth guard) │◄──┤ setInterval(30s)   │   │
│  │              │   │                  │   │ + EventEmitter     │   │
│  └──────┬───────┘   └────────┬─────────┘   └─────────┬──────────┘   │
│         │                    │                       │              │
│         ▼                    ▼                       ▼              │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Service Layer (auth / channel / message / task / approval)    │ │
│  └─────────────────────────────┬──────────────────────────────────┘ │
│                                │                                    │
│                                ▼                                    │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Prisma Client → PostgreSQL                                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                  ┌─────────────────────────┐
                  │   Anthropic API         │
                  │   (claude-3-5-sonnet)   │
                  └─────────────────────────┘
```

`server.ts` 启动顺序：

```
1. createServer(httpHandler)        // Next.js HTTP
2. new Server(httpServer)           // Socket.io 绑定到同一 httpServer
3. registerSocketAuthMiddleware(io) // NextAuth 会话校验
4. AgenticLoop.start(io)            // 30s setInterval + EventEmitter
5. httpServer.listen(PORT)
```

三者共享同一 Node 进程与同一 `EventEmitter`（`agenticEmitter`），便于审批批准事件即时唤醒决策周期。

### 关键数据流

**人类发消息**：UI → `POST /api/messages` → `MessageService.create` → Prisma → `io.to(channelId).emit('message:new', payload)`。

**AI 自主决策**：`setInterval` tick → 对每个未阻塞 AI → `AIRuntime.runCycle(ai)` → 多轮 `messages.create` + 工具调度（含 `create_task`/`send_channel_message` 等通过服务层产生副作用并触发广播）→ 周期结束发出 `ai:thinking` false。

**审批阻塞与唤醒**：AI 工具 `request_approval` → `ApprovalService.create(PENDING)` → `io.emit('approval:created')` → 人类 UI 批准 → `ApprovalService.approve` → `agenticEmitter.emit('wakeup', aiId)` → `AgenticLoop` 立即对该 AI 启动新一轮 `runCycle`，无需等待下一次 30s tick。

## Components and Interfaces

### 目录结构

```
app/
  (auth)/login/page.tsx
  (workspace)/page.tsx
  (workspace)/channels/[channelId]/page.tsx
  (workspace)/board/page.tsx
  api/auth/[...nextauth]/route.ts
  api/messages/route.ts
  api/tasks/route.ts
  api/approvals/[id]/route.ts
components/
  channel/MessageRow.tsx       // 区分 AI 消息（紫色竖线 + AI Badge）
  channel/MessageComposer.tsx
  board/KanbanBoard.tsx        // 4 列固定
  board/TaskCard.tsx
  approval/ApprovalDialog.tsx
  ui/AIBadge.tsx
store/
  useWorkspaceStore.ts          // Zustand：当前频道、思考中的 AI、审批弹窗
lib/
  prisma.ts
  auth/options.ts               // NextAuth Credentials + bcrypt
  services/
    channel.service.ts
    message.service.ts
    task.service.ts             // 含 PROJ-{N} 单调 ID 生成
    approval.service.ts
  ai/
    runtime.ts                  // 多轮循环 + 重试
    tools/index.ts              // 6 个工具的 schema + dispatcher
    prompts.ts                  // Ada / Hopper system prompts
  realtime/
    io.ts                       // Socket.io 实例 + 会话校验中间件
    events.ts                   // 4 个事件类型常量
  loop/
    agentic-loop.ts             // setInterval + EventEmitter 唤醒
prisma/
  schema.prisma
  seed.ts
server.ts
```

### 核心接口签名（TypeScript）

```typescript
// lib/services/message.service.ts
export const MessageService = {
  async create(input: { channelId: string; userId: string; content: string; metadata?: unknown }): Promise<Message>,
  async listByChannel(channelId: string): Promise<Message[]>, // 按 createdAt asc
};

// lib/services/task.service.ts
export type TaskStatus = 'Backlog' | 'InProgress' | 'InReview' | 'Done';
export const TASK_STATUSES: readonly TaskStatus[] = ['Backlog', 'InProgress', 'InReview', 'Done'] as const;

export const TaskService = {
  async create(input: { title: string; description?: string; creatorId: string; assigneeId?: string }): Promise<Task>,
  async updateStatus(taskId: string, status: TaskStatus): Promise<Task>,
  async list(): Promise<Task[]>,
  // 内部：generateNextTaskId() 在事务内 SELECT FOR UPDATE 计数器后 +1，保证单调
};

// lib/services/approval.service.ts
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export const ApprovalService = {
  async create(input: { aiUserId: string; action: string; payload: unknown }): Promise<Approval>,
  async approve(id: string): Promise<Approval>,    // 同步 emit 'wakeup'
  async reject(id: string): Promise<Approval>,
  async listPendingForAI(aiUserId: string): Promise<Approval[]>,
  isStale(approval: Approval, now?: Date): boolean, // > 24h
};

// lib/ai/runtime.ts
export interface RunCycleResult {
  aiUserId: string;
  rounds: number;
  finishReason: 'stop' | 'round_cap' | 'retry_exhausted' | 'rejected';
  durationMs: number;
}
export const AIRuntime = {
  async runCycle(aiUserId: string): Promise<RunCycleResult>,
};

// lib/loop/agentic-loop.ts
export const AgenticLoop = {
  start(io: SocketIOServer): void,    // 启动 30s setInterval 并订阅 agenticEmitter
  stop(): void,
};
export const agenticEmitter: EventEmitter; // 'wakeup' | 'reject'
```

## Data Models

Prisma schema for PostgreSQL:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Workspace {
  id        String   @id @default(cuid())
  name      String
  channels  Channel[]
  users     User[]
  tasks     Task[]
  approvals Approval[]
  taskCounter Int    @default(0)   // 用于生成 PROJ-{N} 的单调计数
  createdAt DateTime @default(now())
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String?                       // 仅人类用户使用
  name         String
  avatarUrl    String?
  isAI         Boolean  @default(false)
  aiRole       String?                       // 'Ada' | 'Hopper'
  workspaceId  String
  workspace    Workspace @relation(fields: [workspaceId], references: [id])
  messages     Message[]
  tasksCreated Task[]   @relation("TaskCreator")
  tasksAssigned Task[]  @relation("TaskAssignee")
  approvals    Approval[]
  createdAt    DateTime @default(now())

  @@index([workspaceId])
  @@index([isAI])
}

model Channel {
  id          String   @id @default(cuid())
  name        String
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  messages    Message[]
  createdAt   DateTime @default(now())

  @@index([workspaceId])
}

model Message {
  id        String   @id @default(cuid())
  channelId String
  channel   Channel  @relation(fields: [channelId], references: [id])
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  content   String   @db.Text
  metadata  Json?                             // 工具调用、引用任务等结构化信息
  createdAt DateTime @default(now())

  @@index([channelId, createdAt])
}

enum TaskStatus {
  Backlog
  InProgress
  InReview
  Done
}

model Task {
  id          String     @id @default(cuid())
  taskId      String     @unique               // PROJ-{N}
  title       String
  description String?    @db.Text
  status      TaskStatus @default(Backlog)
  isAITask    Boolean    @default(false)
  workspaceId String
  workspace   Workspace  @relation(fields: [workspaceId], references: [id])
  creatorId   String
  creator     User       @relation("TaskCreator", fields: [creatorId], references: [id])
  assigneeId  String?
  assignee    User?      @relation("TaskAssignee", fields: [assigneeId], references: [id])
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  @@index([workspaceId, status])
}

enum ApprovalStatus {
  PENDING
  APPROVED
  REJECTED
}

model Approval {
  id          String         @id @default(cuid())
  workspaceId String
  workspace   Workspace      @relation(fields: [workspaceId], references: [id])
  aiUserId    String
  aiUser      User           @relation(fields: [aiUserId], references: [id])
  action      String                                // 例如 "create_task" / "send_channel_message"
  payload     Json
  status      ApprovalStatus @default(PENDING)
  decidedById String?
  decidedAt   DateTime?
  createdAt   DateTime       @default(now())

  @@index([workspaceId, status])
  @@index([aiUserId, status])
}
```

`taskCounter` 字段位于 `Workspace` 上，避免跨表聚合。Task ID 生成依赖该计数器的事务内自增（见后文「Task ID」）。

## AI Runtime（Anthropic SDK + 工具集 + 多轮循环 + 重试）

### 工具集（6 个）

```typescript
// lib/ai/tools/index.ts
import { z } from 'zod';

export const TOOL_DEFINITIONS = [
  {
    name: 'create_task',
    description: 'Create a new task on the kanban board.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200 },
        description: { type: 'string' },
        assigneeId: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task_status',
    description: 'Move a task to a new status column.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },                          // PROJ-{N}
        status: { type: 'string', enum: ['Backlog','InProgress','InReview','Done'] },
      },
      required: ['taskId', 'status'],
    },
  },
  {
    name: 'request_approval',
    description: 'Ask a human to approve a high-risk action before continuing.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        payload: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['action', 'reason'],
    },
  },
  {
    name: 'send_channel_message',
    description: 'Post a message to a channel as this AI colleague.',
    input_schema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        content:   { type: 'string', maxLength: 8000 },
      },
      required: ['channelId', 'content'],
    },
  },
  {
    name: 'mock_web_search',
    description: 'Mock web search returning preset results.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'mock_read_project_docs',
    description: 'Mock project doc reader returning preset content.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
] as const;

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

// Zod 校验器与 dispatcher
const TOOL_ZOD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  create_task: z.object({ title: z.string().min(1).max(200), description: z.string().optional(), assigneeId: z.string().optional() }),
  update_task_status: z.object({ taskId: z.string(), status: z.enum(['Backlog','InProgress','InReview','Done']) }),
  request_approval: z.object({ action: z.string(), payload: z.record(z.unknown()).optional(), reason: z.string() }),
  send_channel_message: z.object({ channelId: z.string(), content: z.string().min(1).max(8000) }),
  mock_web_search: z.object({ query: z.string() }),
  mock_read_project_docs: z.object({ path: z.string() }),
};

export async function dispatchTool(
  ctx: { aiUserId: string },
  call: { id: string; name: string; input: unknown },
): Promise<{ tool_use_id: string; type: 'tool_result'; content: string; is_error?: boolean }> {
  if (!TOOL_NAMES.includes(call.name as typeof TOOL_NAMES[number])) {
    return { tool_use_id: call.id, type: 'tool_result', is_error: true,
             content: `Unknown tool: ${call.name}` };
  }
  const schema = TOOL_ZOD_SCHEMAS[call.name];
  const parsed = schema.safeParse(call.input);
  if (!parsed.success) {
    return { tool_use_id: call.id, type: 'tool_result', is_error: true,
             content: `Invalid arguments: ${parsed.error.message}` };
  }
  // 进入对应分支：调用服务层（create_task / update_task_status / send_channel_message /
  // request_approval），或返回 mock 数据（mock_web_search / mock_read_project_docs）。
  // 服务层成功后会触发 Realtime 广播；这里返回精简的 tool_result 文本。
  // ...
}
```

未列入 `TOOL_NAMES` 的调用一律以 `is_error: true` 的 `tool_result` 回写到下一轮。Mock 工具仅返回内置常量数据，**不**调用 `fetch` 或 `fs`。

### 多轮 tool_use 循环（上限 5 轮）

```typescript
// lib/ai/runtime.ts （核心循环伪代码）
const MAX_ROUNDS = 5;

async function runCycle(aiUserId: string): Promise<RunCycleResult> {
  const ai = await prisma.user.findUniqueOrThrow({ where: { id: aiUserId } });
  const start = Date.now();
  io.emit('ai:thinking', { aiUserId, state: true });

  let messages: Anthropic.MessageParam[] = await buildInitialContext(ai);
  let rounds = 0;
  let finishReason: RunCycleResult['finishReason'] = 'stop';

  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const response = await callAnthropicWithRetry({
        system: SYSTEM_PROMPTS[ai.aiRole!],
        tools: TOOL_DEFINITIONS,
        messages: trimContextToTokenBudget(messages),
      });

      if (response.stop_reason !== 'tool_use') {
        // 模型主动停止，本周期结束
        break;
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUses.map((u) => dispatchTool({ aiUserId }, { id: u.id, name: u.name, input: u.input })),
      );

      // 把模型的 assistant 回复 + 我们生成的 tool_result 全部写回上下文，进入下一轮
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
    if (rounds === MAX_ROUNDS) finishReason = 'round_cap';
  } catch (err) {
    finishReason = 'retry_exhausted';
    logger.error({ err, aiUserId }, 'AI cycle terminated');
  } finally {
    io.emit('ai:thinking', { aiUserId, state: false });
  }

  const result = { aiUserId, rounds, finishReason, durationMs: Date.now() - start };
  logger.info(result, 'ai cycle finished');
  return result;
}
```

### 重试（指数退避，最多 3 次）

```typescript
async function callAnthropicWithRetry(req: MessageCreateParams): Promise<Anthropic.Message> {
  const MAX_RETRIES = 3;          // 即首次 + 3 次重试 = 最多 4 次尝试
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await anthropic.messages.create(req);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      const backoffMs = 500 * 2 ** attempt + Math.random() * 250; // 0.5s, 1s, 2s
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}
```

### 上下文截断

`trimContextToTokenBudget(messages)` 估算 token 数（粗略 4 chars ≈ 1 token），超出预设上限（例如 100k）时**保留尾部最新条目**，逐条丢弃最早的非系统消息直到满足上限。系统提示词作为 `system` 参数单独传递，不计入 messages 截断。

## Agentic Loop（30s setInterval + EventEmitter 唤醒）

```typescript
// lib/loop/agentic-loop.ts
import { EventEmitter } from 'node:events';

export const agenticEmitter = new EventEmitter();
const TICK_MS = 30_000;
const inFlight = new Set<string>();          // 防止同一 AI 并发

async function runForAI(aiUserId: string) {
  if (inFlight.has(aiUserId)) return;
  // 阻塞规则：存在任何 PENDING 审批 → 跳过
  const pending = await ApprovalService.listPendingForAI(aiUserId);
  if (pending.length > 0) return;
  inFlight.add(aiUserId);
  try {
    await AIRuntime.runCycle(aiUserId);
  } catch (err) {
    logger.error({ err, aiUserId }, 'cycle threw');
  } finally {
    inFlight.delete(aiUserId);
  }
}

async function tick() {
  try {
    const ais = await prisma.user.findMany({ where: { isAI: true } });
    await Promise.all(ais.map((ai) => runForAI(ai.id).catch((e) => logger.error(e))));
  } catch (err) {
    logger.error({ err }, 'agentic tick failed');         // 不抛出，保持调度
  }
}

let timer: NodeJS.Timer | null = null;
export const AgenticLoop = {
  start(_io: SocketIOServer) {
    timer = setInterval(tick, TICK_MS);
    agenticEmitter.on('wakeup', (aiUserId: string) => {
      // APPROVED 即时唤醒：不等下一次 tick
      void runForAI(aiUserId);
    });
  },
  stop() {
    if (timer) clearInterval(timer);
    agenticEmitter.removeAllListeners('wakeup');
  },
};
```

`ApprovalService.approve(id)` 在事务提交后调用 `agenticEmitter.emit('wakeup', approval.aiUserId)`，由 `AgenticLoop` 立即对该 AI 启动 `runForAI`。`reject(id)` 不触发唤醒，仅终止当前周期（若该 AI 正在等待此审批的结果）。

## Realtime（Socket.io + NextAuth 会话校验）

### 事件类型

```typescript
// lib/realtime/events.ts
export const EVENTS = {
  MessageNew:      'message:new',       // { id, channelId, userId, content, metadata, createdAt, fromAI }
  TaskUpdated:     'task:updated',      // Task snapshot
  AIThinking:      'ai:thinking',       // { aiUserId, state: boolean }
  ApprovalCreated: 'approval:created',  // Approval snapshot
} as const;
```

### 会话校验中间件

Socket.io 服务端在握手阶段读取请求 cookie，解析 NextAuth session token（与 HTTP 同一进程，可复用 `getServerSession` 等价的解析逻辑）；验证失败立即 `next(new Error('unauthenticated'))`。

```typescript
// lib/realtime/io.ts
io.use(async (socket, next) => {
  try {
    const session = await getSessionFromSocket(socket);   // 解析 cookie 中的 next-auth.session-token
    if (!session?.user) return next(new Error('unauthenticated'));
    socket.data.userId = session.user.id;
    next();
  } catch (err) {
    next(err as Error);
  }
});

io.on('connection', (socket) => {
  socket.join(`workspace:${WORKSPACE_ID}`);
  socket.on('subscribe:channel', (channelId) => socket.join(`channel:${channelId}`));
});
```

广播策略：

- `message:new` → `io.to('channel:{channelId}').emit(...)`
- `task:updated` / `approval:created` / `ai:thinking` → `io.to('workspace:{WORKSPACE_ID}').emit(...)`

服务层在持久化成功后才调用 `io.to(...).emit(...)`，DB 失败时不广播。

客户端使用 `socket.io-client` 默认开启 `reconnection: true`，断线后自动重连。

## Auth（NextAuth Credentials + bcrypt）

```typescript
// lib/auth/options.ts
import CredentialsProvider from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email:    { label: 'Email',    type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) return null;
        const user = await prisma.user.findUnique({ where: { email: credentials.email } });
        if (!user || !user.passwordHash || user.isAI) return null;
        const ok = await compare(credentials.password, user.passwordHash);
        if (!ok) return null;
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token.uid) (session.user as any).id = token.uid;
      return session;
    },
  },
  pages: { signIn: '/login' },
};
```

中间件保护：根布局通过 `getServerSession` 守卫，Next.js `middleware.ts` 拦截所有非 `/login` 与 `/api/auth/*` 路径，未登录则 302 至 `/login`。

种子（`prisma/seed.ts`）创建 1 个 Workspace、2-3 个人类（带 bcrypt 哈希）、2 个 AI（`Ada`、`Hopper`，`isAI=true`，`passwordHash=null`，`aiRole` 各异），并预置默认频道 `#general` 与 `#engineering`。

## Task ID（PROJ-{N} 单调递增）

任务 ID 在事务内自增 `Workspace.taskCounter`：

```typescript
// lib/services/task.service.ts （ID 生成片段）
async function generateNextTaskId(tx: Prisma.TransactionClient): Promise<string> {
  const updated = await tx.workspace.update({
    where: { id: WORKSPACE_ID },
    data:  { taskCounter: { increment: 1 } },
    select: { taskCounter: true },
  });
  return `PROJ-${updated.taskCounter}`;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  return prisma.$transaction(async (tx) => {
    const taskId = await generateNextTaskId(tx);
    const creator  = await tx.user.findUniqueOrThrow({ where: { id: input.creatorId } });
    const assignee = input.assigneeId
      ? await tx.user.findUnique({ where: { id: input.assigneeId } })
      : null;
    const isAITask = creator.isAI || (assignee?.isAI ?? false);
    return tx.task.create({
      data: {
        taskId,
        title: input.title,
        description: input.description,
        status: 'Backlog',
        isAITask,
        workspaceId: WORKSPACE_ID,
        creatorId: creator.id,
        assigneeId: assignee?.id,
      },
    });
  });
  // 事务提交后由调用方触发 io.emit('task:updated', task)
}
```

PostgreSQL 在 `UPDATE ... RETURNING` 中持有行级锁，保证并发创建任务时 `taskCounter` 严格单调递增；`taskId` 字段加 `@unique`，作为最后防线。

## Error Handling

| 失败点 | 处理策略 |
| --- | --- |
| Anthropic 调用失败 | `callAnthropicWithRetry` 指数退避最多 3 次重试；失败抛出，由 `runCycle` 捕获、记录日志、`finishReason='retry_exhausted'`、广播 `ai:thinking=false` |
| 工具名未在 6 个之内 | `dispatchTool` 返回 `tool_result { is_error: true, content: 'Unknown tool: ...' }`；不抛出 |
| 工具参数 schema 校验失败 | 同上，`is_error: true` 回写到下一轮 |
| 服务层 DB 写失败 | 抛出至调用方；Realtime **不广播**未持久化的事件 |
| Socket.io 握手会话失败 | `next(new Error('unauthenticated'))`，连接被拒绝 |
| `setInterval` tick 内异常 | `tick()` 顶层 try/catch，记录日志，**不抛出**，下一次 tick 仍按时调度 |
| 单 AI 决策周期异常 | `runForAI` 自身 try/catch，记录日志，从 `inFlight` 集合中移除该 AI |
| 审批 24h 未处理 | `Approval.isStale` 在查询时计算返回 `true`；UI 显著标注；状态保持 `PENDING` |
| 消息长度 > 8000 / 全空白 | `MessageService.create` 抛出 `ValidationError`，路由层返回 400 |

所有异常通过结构化日志（`pino` 或等价库）输出，至少包含 `aiUserId`、`rounds`、`finishReason`、`durationMs`、错误堆栈。

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: 认证基于 bcrypt 的双向正确性

For any seeded human user `(email, password)`, calling `authorize({ email, password })` returns the user record; for any password `wrong ≠ password` or any email not in the database, `authorize` returns `null` and creates no session.

**Validates: Requirements 1.2, 1.3**

### Property 2: 频道消息按时间正序返回

For any random set of `Message` rows with arbitrary `createdAt` timestamps inserted into a channel, `MessageService.listByChannel(channelId)` returns the messages in non-decreasing `createdAt` order.

**Validates: Requirements 2.2**

### Property 3: 消息持久化—广播一致性

For any valid message input that `MessageService.create` accepts, exactly one `message:new` event is emitted to `channel:{channelId}` with a payload whose stored fields equal the persisted row, and no event is emitted when persistence fails.

**Validates: Requirements 2.3, 2.4, 8.4, 10.4**

### Property 4: AI 来源标记

For any persisted `Message` whose sender has `isAI = true`, the broadcast payload carries an AI marker (`fromAI === true`); for any sender with `isAI = false`, `fromAI === false`.

**Validates: Requirements 2.5, 4.4**

### Property 5: 消息内容校验

For any string `content`, `MessageService.create` accepts it iff `content.trim().length > 0` and `content.length <= 8000`; otherwise it rejects with a validation error and persists nothing.

**Validates: Requirements 2.6, 2.7**

### Property 6: Task ID 单调递增且唯一

For any sequence of `TaskService.create` calls (serial or concurrent) within a single workspace, the resulting `taskId` values match `/^PROJ-\d+$/`, are pairwise unique, and the sequence of parsed integers is strictly increasing in commit order.

**Validates: Requirements 3.2**

### Property 7: 新任务默认 Backlog

For any input accepted by `TaskService.create`, the resulting `Task.status` equals `'Backlog'`.

**Validates: Requirements 3.3**

### Property 8: 状态更新值域

For any string `s`, `TaskService.updateStatus(taskId, s)` succeeds iff `s ∈ {'Backlog','InProgress','InReview','Done'}`; otherwise it rejects without mutating the task.

**Validates: Requirements 3.4, 5.6**

### Property 9: 任务创建/更新—广播一致性

For any successful `TaskService.create` or `TaskService.updateStatus` call, exactly one `task:updated` event is emitted to `workspace:{WORKSPACE_ID}` carrying the latest task snapshot; no event is emitted when persistence fails.

**Validates: Requirements 3.5, 5.5, 5.6, 8.5, 10.4**

### Property 10: isAITask 派生自参与者

For any `Task` written by `TaskService`, `isAITask === (creator.isAI || (assignee?.isAI ?? false))`.

**Validates: Requirements 3.6**

### Property 11: 角色化 system prompt 注入

For any AI colleague with `aiRole = r`, every `anthropic.messages.create` call issued for that AI within `runCycle` carries `system === SYSTEM_PROMPTS[r]`.

**Validates: Requirements 4.2**

### Property 12: 工具表面恒等

For any `runCycle` invocation, the `tools` field passed to `anthropic.messages.create` is exactly the 6-element set `{create_task, update_task_status, request_approval, send_channel_message, mock_web_search, mock_read_project_docs}` (as a set).

**Validates: Requirements 5.1**

### Property 13: 工具调度的全函数性

For any tool call `{ id, name, input }`, `dispatchTool` returns a `tool_result` (never throws): if `name ∉ TOOL_NAMES` or `input` fails the tool's zod schema, the result has `is_error === true` carrying the failure reason; otherwise the corresponding service-layer effect occurs and the result has `is_error` falsy.

**Validates: Requirements 5.2, 5.3, 10.3**

### Property 14: Mock 工具的纯净性

For any input to `mock_web_search` or `mock_read_project_docs`, the dispatcher returns the deterministic preset payload, makes zero outbound `fetch` calls, and zero filesystem reads.

**Validates: Requirements 5.4**

### Property 15: send_channel_message 工具的发送者归属

For any `send_channel_message` tool call dispatched on behalf of AI colleague `aiUserId`, the persisted `Message.userId === aiUserId` and exactly one `message:new` event is emitted on the target channel.

**Validates: Requirements 5.7, 4.4**

### Property 16: 审批创建—广播一致性

For any `request_approval` tool call accepted by the dispatcher, exactly one `Approval` row is created with `status = 'PENDING'` and exactly one `approval:created` event is emitted; no event is emitted when persistence fails.

**Validates: Requirements 5.8, 6.1, 8.6, 10.4**

### Property 17: tool_result 完整回写

For any cycle round in which the model returns `k` `tool_use` blocks, the immediately next request issued to Anthropic includes a `user` message whose content contains exactly `k` `tool_result` blocks with `tool_use_id` values bijecting to those `k` `tool_use` ids.

**Validates: Requirements 5.9**

### Property 18: 审批状态值域

For any candidate `s`, `ApprovalService` only persists transitions where `s ∈ {'PENDING','APPROVED','REJECTED'}`; other values are rejected without mutating the row.

**Validates: Requirements 6.2**

### Property 19: 审批阻塞与即时唤醒（Agentic 门控）

For any AI colleague `a` and any moment `t`:
- If there exists a `PENDING` approval for `a` at time `t`, then no new `runCycle(a)` is started at the next `setInterval` tick.
- If an approval transitions `PENDING → APPROVED` for `a` at time `t`, then `runForAI(a)` is invoked within ε of `t`, regardless of when the next 30s tick is scheduled.

**Validates: Requirements 6.3, 6.5, 6.6, 7.2**

### Property 20: 拒绝终止当轮周期

For any `PENDING` approval that transitions to `REJECTED`, the row is updated to `REJECTED` and the in-flight cycle on behalf of the requesting AI completes with `finishReason = 'rejected'` (or has already terminated); no `wakeup` is emitted.

**Validates: Requirements 6.4**

### Property 21: 陈旧审批检测

For any `Approval` `a` and any `now` such that `now - a.createdAt > 24h`, `ApprovalService.isStale(a, now) === true`; for any `now ≤ a.createdAt + 24h`, `isStale === false`. The status field is unchanged by this query.

**Validates: Requirements 6.7**

### Property 22: 多轮上限与终止原因

For any `runCycle` invocation against a model that always returns `tool_use`, the runtime issues at most 5 calls to `anthropic.messages.create` and the result has `rounds ≤ 5` with `finishReason = 'round_cap'` when the cap is reached.

**Validates: Requirements 7.3, 7.4**

### Property 23: 上下文截断保留尾部

For any conversation `messages` and any `tokenBudget`, `trimContextToTokenBudget(messages)` returns a contiguous suffix of `messages` whose estimated tokens are `≤ tokenBudget`.

**Validates: Requirements 7.5**

### Property 24: ai:thinking 配对广播

For any completed `runCycle(a)`, exactly one `ai:thinking { aiUserId: a, state: true }` event precedes exactly one `ai:thinking { aiUserId: a, state: false }` event in the workspace room, and no other `ai:thinking` events for `a` are emitted during the cycle.

**Validates: Requirements 7.6, 7.7**

### Property 25: Socket.io 会话校验

For any incoming Socket.io handshake, the connection is accepted iff the request carries a valid NextAuth session; otherwise the connection is rejected before any room is joined.

**Validates: Requirements 8.2, 8.3**

### Property 26: 实时延迟上限

For any successful service-layer write (message / task / approval), the corresponding broadcast is emitted within 1000 ms of the write's commit (measured against an in-process fake clock harness).

**Validates: Requirements 8.4, 8.5, 8.6**

### Property 27: 相对时间渲染

For any `Date d`, the `<TimeAgo d />` component renders text equal to `formatDistanceToNow(d, { addSuffix: true })` from `date-fns`.

**Validates: Requirements 9.4**

### Property 28: 重试上限

For any sequence of Anthropic call outcomes where the first `k` attempts throw and subsequent attempts succeed, `callAnthropicWithRetry` issues exactly `min(k, 3) + 1` attempts; if `k > 3`, it ultimately rethrows and `runCycle` records `finishReason = 'retry_exhausted'`.

**Validates: Requirements 10.1, 10.2**

### Property 29: tick 异常隔离

For any tick handler invocation that throws internally, the next scheduled tick is still invoked, and per-AI exceptions do not terminate sibling AIs' cycles within the same tick.

**Validates: Requirements 10.6**

## Testing Strategy

**Dual approach.** Property-based tests cover universal logic invariants (the 29 properties above); example-based unit tests cover concrete UI structure, configuration, and one-shot setup; integration tests cover end-to-end wiring (Socket.io connection, NextAuth sign-in, Prisma seed).

**Library choices**:
- Property-based: `fast-check` (TypeScript-native, integrates with Vitest).
- Unit / integration: `vitest` + `@testing-library/react`.
- Mocks: `vitest`'s `vi.mock` for Anthropic SDK, Socket.io server, Prisma client (or `prisma-mock` / a test database with transactions rolled back).

**Configuration**:
- Each property test runs **at least 100 iterations** (`fc.assert(prop, { numRuns: 100 })`).
- Each property test is tagged with: `Feature: ai-native-team-workspace, Property {N}: {title}`.

**Test layering**:

| Layer | Coverage | Key concerns |
| --- | --- | --- |
| Property (pure logic) | Properties 5, 6, 7, 8, 10, 13, 14, 18, 21, 22, 23, 27, 28 | Generators for messages, tasks, approvals, conversations |
| Property (with mocks) | Properties 1, 2, 3, 4, 9, 11, 12, 15, 16, 17, 19, 20, 24, 25, 26, 29 | Mock Anthropic, mock Prisma transactions, mock Socket.io with spies, fake timers via `vi.useFakeTimers()` |
| Example unit tests | UI layout (Kanban 4 cols, AI badge, MessageRow purple accent), middleware redirects, NextAuth provider config | shadcn/ui rendering, route guards |
| Smoke / setup | Seed creates expected users/channels, `server.ts` boots HTTP+Socket.io+Loop, `EVENTS` constants, `setInterval` interval = 30000 | One-shot assertions |
| Integration | Sign-in → Socket connect → send message → receive `message:new`; AI cycle end-to-end with stub Anthropic returning `tool_use` then `end_turn`; approval approve triggers wakeup within ε | Full stack happy path with 1-2 examples each |

**Generators (sketch)**:

```typescript
const validContent  = fc.string({ minLength: 1, maxLength: 8000 }).filter((s) => s.trim().length > 0);
const invalidContent = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length === 0),
  fc.string({ minLength: 8001, maxLength: 16000 }),
);
const taskStatus = fc.constantFrom('Backlog', 'InProgress', 'InReview', 'Done');
const arbitraryStatus = fc.oneof(taskStatus, fc.string());
const toolName = fc.constantFrom(...TOOL_NAMES);
const arbitraryToolName = fc.oneof(toolName, fc.string());
```

**What we explicitly do NOT property-test**:
- Anthropic API itself (we mock it).
- AWS / external infrastructure (out of scope for MVP).
- shadcn/ui internal rendering (covered by example tests).
- The dark theme color values (configuration check only).
