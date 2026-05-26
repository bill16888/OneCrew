# 项目弱点修复 — 完整开发计划

> 基于: 代码审查 + HiveWard 对比分析 + 四方向升级蓝图  
> 目标: 逐项消除弱点，每个弱点有方案、有流程、有验收标准

---

## 弱点总览 & 修复优先级

| # | 弱点 | 严重度 | 工作量 | 修复窗口 | 依赖 |
|---|------|--------|--------|---------|------|
| W1 | AI 同事硬编码（不可创建/自定义） | 🔴 | 2天 | 第1周 | 无 |
| W2 | AI 不能 @ 触发（仅 30s 巡检） | 🔴 | 0.5天 | 第1周 | 无 |
| W3 | AI 工具太弱（6个，2个 mock） | 🟡 | 2天 | 第2周 | 无 |
| W4 | 无频道成员管理 | 🟡 | 2天 | 第2周 | 无 |
| W5 | reject 审批流程未接完 | 🟡 | 0.5天 | 第1周 | 无 |
| W6 | 无 AI 工作汇报 | 🟡 | 1天 | 第3周 | W1 |
| W7 | AI 后端单一（仅 DeepSeek） | 🟡 | 2天 | 第3周 | W3 |
| W8 | 无工作流编排 | 🟡 | 4天 | 第5-6周 | W1, W3 |
| W9 | 无 CLI / 一键部署 | 🔵 | 1天 | 第4周 | 无 |
| W10 | 无经验积累（AI 产出不复用） | 🔵 | 2天 | 第7周 | W8 |

---

## 第 1 周：核心体验修复（W1 + W2 + W5）

---

### W1：AI 同事硬编码 → 可创建/自定义 AI 员工

#### 现状

```typescript
// prisma/seed.ts — AI 同事写死在 seed 中
const AI_USERS = [
  { id: 'user_ai_ada', email: 'ada@helio.local', name: 'Ada', aiRole: 'Ada' },
  { id: 'user_ai_hopper', email: 'hopper@helio.local', name: 'Hopper', aiRole: 'Hopper' },
];

// lib/ai/prompts.ts — system prompt 写死
export const SYSTEM_PROMPTS: Record<AIRoleName, string> = {
  Ada: ADA_PROMPT,
  Hopper: HOPPER_PROMPT,
};

// lib/loop/agentic-loop.ts — Agentic Loop 硬编码 Ada/Hopper
if (aiRole !== 'Ada' && aiRole !== 'Hopper') {
  throw new Error(`unsupported aiRole`);
}
```

#### 修复方案

**Step 1: Prisma Schema 增加 AI 配置字段（30分钟）**

```prisma
// prisma/schema.prisma — User 模型新增

model User {
  // ... 现有字段 ...

  // 新增: AI 同事配置
  aiSettings  Json?     // { systemPrompt, toolSet[], avatarUrl, status, createdBy }
  aiStatus    String?   @default("active") // active | inactive

  // aiRole 改为可选（不再硬编码 Ada/Hopper）
  aiRole      String?
}
```

```bash
npx prisma migrate dev --name add_ai_settings
```

**Step 2: 改写 lib/ai/prompts.ts（30分钟）**

```typescript
// lib/ai/prompts.ts — 从硬编码 Map 改为 DB 读取

import prisma from '@/lib/prisma';

// 保留默认 prompt 作为模板/fallback
export const DEFAULT_AI_SYSTEM_PROMPT = `你是一个 AI 团队成员...`;

// 新增: 从 DB 读取 AI 的 system prompt
export async function getSystemPrompt(aiUserId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: aiUserId },
    select: { aiSettings: true, aiRole: true },
  });

  const settings = user.aiSettings as Record<string, unknown> | null;
  if (settings?.systemPrompt && typeof settings.systemPrompt === 'string') {
    return settings.systemPrompt;
  }

  // fallback: 旧版 aiRole 对应的 prompt
  if (user.aiRole === 'Ada') return ADA_PROMPT;
  if (user.aiRole === 'Hopper') return HOPPER_PROMPT;

  return DEFAULT_AI_SYSTEM_PROMPT;
}

export type AIRoleName = string; // 改为 string，不再限制 Ada/Hopper
```

**Step 3: 改写 lib/ai/runtime.ts（30分钟）**

```typescript
// lib/ai/runtime.ts — runCycle 中

// 旧: 硬编码 aiRole 校验
if (aiRole !== 'Ada' && aiRole !== 'Hopper') {
  throw new Error(`unsupported aiRole`);
}

// 新: 移除校验，改为 DB 读取
const system = await getSystemPrompt(aiUserId);
```

**Step 4: 改写 lib/loop/agentic-loop.ts（15分钟）**

```typescript
// lib/loop/agentic-loop.ts — tick() 中

// 旧: 从 DB 读取 isAI=true 的用户
const ais = await prisma.user.findMany({ where: { isAI: true } });

// 新: 只读取 active 的 AI
const ais = await prisma.user.findMany({
  where: { isAI: true, aiStatus: 'active' },
  select: { id: true },
});
```

**Step 5: API 端点（1小时）**

```typescript
// app/api/ai-colleagues/route.ts

import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { authOptions } from '@/lib/auth/options';

const createAISchema = z.object({
  name: z.string().min(1).max(50),
  email: z.string().email(),
  systemPrompt: z.string().min(1),
  toolSet: z.array(z.string()).default([
    'create_task', 'update_task_status',
    'send_channel_message', 'request_approval',
    'mock_web_search', 'mock_read_project_docs',
  ]),
  avatarUrl: z.string().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = createAISchema.parse(await request.json());

  const aiUser = await prisma.user.create({
    data: {
      name: body.name,
      email: body.email,
      isAI: true,
      passwordHash: null,  // AI 不能登录
      aiStatus: 'active',
      aiSettings: {
        systemPrompt: body.systemPrompt,
        toolSet: body.toolSet,
        avatarUrl: body.avatarUrl ?? null,
        status: 'active',
        createdBy: session.user.id,
      },
      workspaceId: process.env.WORKSPACE_ID || 'ws_default',
    },
  });

  return NextResponse.json(aiUser, { status: 201 });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ais = await prisma.user.findMany({
    where: { isAI: true },
    select: {
      id: true, name: true, email: true,
      aiRole: true, aiStatus: true, aiSettings: true,
      createdAt: true,
    },
  });

  return NextResponse.json(ais);
}
```

```typescript
// app/api/ai-colleagues/[id]/route.ts

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();

  const updated = await prisma.user.update({
    where: { id: params.id, isAI: true },
    data: {
      name: body.name,
      aiSettings: body.aiSettings,
      aiStatus: body.aiStatus,
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 软删除: 标记 inactive，保留历史消息
  await prisma.user.update({
    where: { id: params.id, isAI: true },
    data: { aiStatus: 'inactive' },
  });

  return NextResponse.json({ success: true });
}
```

**Step 6: 前端 UI（4小时）**

```
新增文件:
  app/(workspace)/ai-colleagues/page.tsx     → AI 管理页
  components/ai-teammates/TeammateManager.tsx → 管理面板组件
  components/ai-teammates/HireDialog.tsx      → 雇佣弹窗组件
  components/ai-teammates/EditTeammateDialog.tsx → 编辑弹窗组件

HireDialog 包含字段:
  - 名字 (text input)
  - 邮箱 (text input, 自动生成 @xxx.ai.local)
  - 角色描述 (textarea → system prompt)
  - 可用工具 (checkbox 组)
  - 头像 (可选)

TeammateManager 展示:
  - 每个 AI 的状态（active/inactive）
  - 启用/停用按钮
  - 编辑按钮
  - 创建时间
```

**验收标准：**
```
[ ] 用户可在 UI 创建新 AI 员工（设置名字、角色、工具）
[ ] 用户可编辑已有 AI 员工
[ ] 用户可停用 AI 员工（不影响历史消息）
[ ] Agentic Loop 只巡检 active 的 AI
[ ] runCycle 从 DB 读取 system prompt（而非硬编码）
[ ] 创建 AI 后无需重启即可参与 cycle
```

---

### W2：AI 不能 @ 触发 → @AI 名字即刻唤醒

#### 现状

AI 只能通过 30s Agentic Loop 定时巡检，人类无法主动调遣。

#### 修复方案

**Step 1: MessageService 增加 @检测（30分钟）**

```typescript
// lib/services/message.service.ts — create() 函数末尾追加

import { agenticEmitter } from '@/lib/loop/emitter';
import prisma from '@/lib/prisma';

// 在 create() 函数 return 之前:

// 检测 @AI 名字并触发 wakeup
if (input.content.includes('@')) {
  const mentionedNames = extractMentions(input.content);
  if (mentionedNames.length > 0) {
    const aiUsers = await prisma.user.findMany({
      where: {
        isAI: true,
        aiStatus: 'active',
        name: { in: mentionedNames },
      },
      select: { id: true, name: true },
    });

    for (const ai of aiUsers) {
      agenticEmitter.emit('wakeup', ai.id);
    }
  }
}

/**
 * 从消息内容中提取 @名字 列表
 * "@Ada 帮我看看 bug @Hopper 记录一下" → ["Ada", "Hopper"]
 */
function extractMentions(content: string): string[] {
  const matches = content.match(/@([\w一-鿿]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}
```

**验收标准：**
```
[ ] 在频道里发 "@AI名字 xxx" → AI 3 秒内响应
[ ] @多个 AI → 每个都被唤醒
[ ] @不存在的名字 → 不影响
[ ] @inactive 的 AI → 不唤醒
```

---

### W5：reject 审批流程未接完

#### 现状

`finishReason: 'rejected'` 类型已定义，`agenticEmitter.emit('reject', ...)` 已发射，但 runtime.ts 未监听。

#### 修复方案

**Step 1: runtime.ts 加 reject 监听（30分钟）**

```typescript
// lib/ai/runtime.ts — runCycle() 函数

export async function runCycle(aiUserId: string): Promise<RunCycleResult> {
  // ... 现有代码 ...

  let rejected = false;

  // 监听 reject 事件
  function onReject(id: string) {
    if (id === aiUserId) {
      rejected = true;
    }
  }
  agenticEmitter.on('reject', onReject);

  try {
    // ... 多轮 tool_use 循环 ...
    while (rounds < MAX_ROUNDS) {
      // 每轮开始前检查是否被 reject
      if (rejected) {
        finishReason = 'rejected';
        break;
      }
      // ... 现有循环体 ...
    }
  } finally {
    // 清理监听器
    agenticEmitter.off('reject', onReject);
    emitThinking(aiUserId, false);
  }
  // ...
}
```

**验收标准：**
```
[ ] 人类拒绝审批 → AI 立即停止当前 cycle
[ ] finishReason 为 'rejected'（不是 'stop' 或 'round_cap'）
[ ] 不影响正常完成的 cycle
[ ] reject 后不发射 wakeup（已有逻辑保证）
```

---

## 第 2 周：AI 能力提升（W3 + W4）

---

### W3：AI 工具太弱 → 真实工具 + 新增工具

#### 现状

6 个工具中 2 个是 mock（返回假数据），其余 4 个只能操作内部系统。

#### 修复方案

**Step 1: 替换 mock_web_search → Tavily Search API（1小时）**

```bash
npm install @tavily/core
```

```typescript
// lib/ai/tools/real-search.ts (新文件)

import { tavily } from '@tavily/core';

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });

export async function realWebSearch(query: string): Promise<string> {
  try {
    const result = await tvly.search(query, {
      searchDepth: 'basic',
      maxResults: 5,
    });

    return result.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`)
      .join('\n\n') || 'No results found.';
  } catch (err) {
    return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

```typescript
// lib/ai/tools/index.ts — 修改 dispatchTool

case 'mock_web_search': {
  // 旧: return buildToolResult(call.id, mockWebSearch(query));
  const { query } = input as { query: string };
  const result = await realWebSearch(query);
  return buildToolResult(call.id, result);
}
```

**Step 2: 替换 mock_read_project_docs → GitHub Contents API（1小时）**

```typescript
// lib/ai/tools/real-github.ts (新文件)

export async function realReadGitHubFile(
  repo: string,
  path: string,
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return 'GitHub token not configured.';

  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) return `GitHub API error: ${res.status}`;
  const data = await res.json();
  if (data.content) {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  return JSON.stringify(data, null, 2);
}
```

**Step 3: 新增 3 个真实工具（1小时）**

```typescript
// lib/ai/tools/index.ts — TOOL_DEFINITIONS 追加

// 新增工具 7: create_github_issue
{
  name: 'create_github_issue',
  description: 'Create a GitHub issue in the team repository.',
  input_schema: {
    type: 'object',
    properties: {
      repo: { type: 'string' },
      title: { type: 'string', maxLength: 200 },
      body: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['repo', 'title'],
  },
},

// 新增工具 8: read_web_page
{
  name: 'read_web_page',
  description: 'Fetch and read the content of a web page.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
    },
    required: ['url'],
  },
},

// 新增工具 9: send_notification
{
  name: 'send_notification',
  description: 'Send a notification to a human team member. Requires approval.',
  input_schema: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
      message: { type: 'string', maxLength: 500 },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
    },
    required: ['userId', 'message'],
  },
},
```

**Step 4: Zod schemas + dispatcher cases（1小时）**

```typescript
// lib/ai/tools/index.ts — 追加 Zod schemas

create_github_issue: z.object({
  repo: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
}),

read_web_page: z.object({
  url: z.string().url(),
}),

send_notification: z.object({
  userId: z.string().min(1),
  message: z.string().min(1).max(500),
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
}),
```

**验收标准：**
```
[ ] web_search 返回真实搜索结果（非 mock）
[ ] read_docs 可读取真实 GitHub 文件
[ ] AI 可创建 GitHub Issue
[ ] AI 可读取网页内容
[ ] AI 可发送通知给人类
[ ] 所有新工具的错误均以 is_error tool_result 返回（不抛异常）
```

---

### W4：无频道成员管理 → 拉入/踢出频道

#### 修复方案

**Step 1: Prisma Schema（15分钟）**

```prisma
model ChannelMember {
  channelId String
  userId    String
  channel   Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user      User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  joinedAt  DateTime @default(now())

  @@id([channelId, userId])
  @@index([userId])
}
```

**Step 2: API 端点（30分钟）**

```typescript
// app/api/channels/[channelId]/members/route.ts

// POST — 添加成员
export async function POST(
  request: Request,
  { params }: { params: { channelId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { userId } = await request.json();

  const member = await prisma.channelMember.create({
    data: { channelId: params.channelId, userId },
  });

  return NextResponse.json(member, { status: 201 });
}

// DELETE — 移除成员
export async function DELETE(
  request: Request,
  { params }: { params: { channelId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { userId } = await request.json();

  await prisma.channelMember.delete({
    where: {
      channelId_userId: {
        channelId: params.channelId,
        userId,
      },
    },
  });

  return NextResponse.json({ success: true });
}

// GET — 频道成员列表
export async function GET(
  _request: Request,
  { params }: { params: { channelId: string } }
) {
  const members = await prisma.channelMember.findMany({
    where: { channelId: params.channelId },
    include: { user: { select: { id: true, name: true, isAI: true } } },
  });

  return NextResponse.json(members);
}
```

**Step 3: Socket.io 频道订阅改为基于成员关系（15分钟）**

```typescript
// lib/realtime/io.ts — subscribe:channel handler

socket.on('subscribe:channel', async (channelId: string) => {
  if (typeof channelId !== 'string' || channelId.length === 0) return;

  // 验证用户是否是该频道成员
  const membership = await prisma.channelMember.findUnique({
    where: {
      channelId_userId: {
        channelId,
        userId: socket.data.userId!,
      },
    },
  });
  if (!membership) return; // 不是成员，拒绝订阅

  void socket.join(`channel:${channelId}`);
});
```

**验收标准：**
```
[ ] 可将 AI/人类拉入频道
[ ] 可将 AI/人类踢出频道
[ ] 踢出后不再接收该频道的 message:new
[ ] 非成员无法订阅频道
```

---

## 第 3 周：智能化提升（W6 + W7）

---

### W6：无 AI 工作汇报 → 自动日报/周报

#### 修复方案

**Step 1: 日报生成函数（1小时）**

```typescript
// lib/services/report.service.ts (新文件)

import prisma from '@/lib/prisma';
import { MessageService } from './message.service';

export async function generateDailyReport(aiUserId: string): Promise<string> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 统计今日数据
  const [tasksCreated, tasksMoved, messagesSent] = await Promise.all([
    prisma.task.count({
      where: { creatorId: aiUserId, createdAt: { gte: today } },
    }),
    prisma.task.count({
      where: {
        creatorId: aiUserId,  // 简化为: AI 创建的且状态非 Backlog 就是「移动过的」
        updatedAt: { gte: today },
        status: { not: 'Backlog' },
      },
    }),
    prisma.message.count({
      where: { userId: aiUserId, createdAt: { gte: today } },
    }),
  ]);

  const ai = await prisma.user.findUniqueOrThrow({
    where: { id: aiUserId },
    select: { name: true },
  });

  return [
    `## ${ai.name} 今日工作报告`,
    ``,
    `- 创建任务: ${tasksCreated} 个`,
    `- 推进任务: ${tasksMoved} 个`,
    `- 发送消息: ${messagesSent} 条`,
    `- 工作时间: ${new Date().toLocaleDateString('zh-CN')}`,
  ].join('\n');
}
```

**Step 2: 定时任务 — 每天 18:00 触发（30分钟）**

```typescript
// lib/loop/daily-report.ts (新文件)

import nodeCron from 'node-cron';
import prisma from '@/lib/prisma';
import { MessageService } from '@/lib/services/message.service';
import { generateDailyReport } from '@/lib/services/report.service';
import { logger } from '@/lib/logger';

export function startDailyReportScheduler(): void {
  // 每天 18:00 (UTC+8)
  nodeCron.schedule('0 18 * * *', async () => {
    logger.info('Generating daily AI reports...');

    const activeAIs = await prisma.user.findMany({
      where: { isAI: true, aiStatus: 'active' },
      select: { id: true },
    });

    for (const ai of activeAIs) {
      try {
        const report = await generateDailyReport(ai.id);
        // 发送到 #general 频道
        const generalChannel = await prisma.channel.findFirst({
          where: { workspaceId: process.env.WORKSPACE_ID || 'ws_default', name: 'general' },
        });
        if (generalChannel) {
          await MessageService.create({
            channelId: generalChannel.id,
            userId: ai.id,
            content: report,
            metadata: { event: 'daily_report' },
          });
        }
      } catch (err) {
        logger.error({ aiUserId: ai.id, err }, 'Failed to generate daily report');
      }
    }
  });
}
```

**Step 3: 在 server.ts 中启动（5分钟）**

```typescript
// server.ts — startServer() 函数中

import { startDailyReportScheduler } from '@/lib/loop/daily-report';

// 在 initScheduler 或 AgenticLoop.start 之后:
startDailyReportScheduler();
```

**验收标准：**
```
[ ] 每天 18:00 AI 自动在 #general 发工作报告
[ ] 报告包含: 创建任务数、推进任务数、发送消息数
[ ] 生成失败不影响 Agentic Loop
[ ] 生成失败有日志记录
```

---

### W7：AI 后端单一 → 支持多种 AI 后端

#### 修复方案

**Step 1: AI 后端抽象层（1小时）**

```typescript
// lib/ai/providers/types.ts (新文件)

export interface AIProvider {
  readonly name: string;
  chat(params: ChatParams): Promise<ChatResult>;
}

export interface ChatParams {
  model: string;
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  max_tokens: number;
}

export interface ChatResult {
  stop_reason: string;
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}
```

```typescript
// lib/ai/providers/deepseek.ts (新文件)

import OpenAI from 'openai';
import { env } from '@/lib/env';
import type { AIProvider, ChatParams, ChatResult } from './types';

export class DeepSeekProvider implements AIProvider {
  readonly name = 'deepseek';
  private client = new OpenAI({
    apiKey: env.DEEPSEEK_API_KEY,
    baseURL: env.DEEPSEEK_BASE_URL,
  });

  async chat(params: ChatParams): Promise<ChatResult> {
    // 复用现有的 OpenAI bridge 逻辑
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: [{ role: 'system', content: params.system }, ...params.messages],
      tools: params.tools,
      max_tokens: params.max_tokens,
    });
    return toChatResult(response);
  }
}
```

```typescript
// lib/ai/providers/anthropic-direct.ts (新文件)

import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ChatParams, ChatResult } from './types';

export class AnthropicDirectProvider implements AIProvider {
  readonly name = 'anthropic';
  private client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  async chat(params: ChatParams): Promise<ChatResult> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      max_tokens: params.max_tokens,
    });
    return toChatResult(response);
  }
}
```

```typescript
// lib/ai/providers/index.ts (新文件)

import type { AIProvider } from './types';
import { DeepSeekProvider } from './deepseek';

let providers: Record<string, AIProvider> = {
  deepseek: new DeepSeekProvider(),
};

// 可选: 动态加载 Anthropic Provider
if (process.env.ANTHROPIC_API_KEY) {
  const { AnthropicDirectProvider } = await import('./anthropic-direct');
  providers.anthropic = new AnthropicDirectProvider();
}

export function getProvider(name?: string): AIProvider {
  const key = name || 'deepseek';
  const provider = providers[key];
  if (!provider) throw new Error(`Unknown AI provider: ${key}`);
  return provider;
}
```

**Step 2: AI 员工可选择后端（30分钟）**

```typescript
// AI 员工的 aiSettings JSON 增加字段:
{
  "provider": "deepseek" | "anthropic",
  "model": "deepseek-chat" | "claude-sonnet-4-20250514"
}

// runtime.ts 中:
const settings = ai.aiSettings as Record<string, unknown>;
const provider = getProvider(settings?.provider as string);
```

**验收标准：**
```
[ ] 支持 DeepSeek（已有）
[ ] 可选 Anthropic Direct
[ ] AI 员工可单独选择后端
[ ] 切换后端无需改代码
```

---

## 第 4 周：分发优化（W9）

---

### W9：无 CLI 分发 → npx 一键启动

```typescript
// cli.ts (新文件 — 项目根目录)

#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'setup':
      console.log('Setting up [产品名]...');
      execSync('npm install', { stdio: 'inherit' });
      execSync('npx prisma generate', { stdio: 'inherit' });
      execSync('npx prisma migrate deploy', { stdio: 'inherit' });
      execSync('npx prisma db seed', { stdio: 'inherit' });
      console.log('✅ Setup complete. Run `npx [产品名] start`');
      break;

    case 'start':
      console.log('Starting [产品名]...');
      execSync('npm run start', { stdio: 'inherit' });
      break;

    case 'dev':
      console.log('Starting [产品名] in dev mode...');
      execSync('npm run dev', { stdio: 'inherit' });
      break;

    default:
      console.log(`
Usage:
  npx [产品名] setup   — 安装依赖 + 初始化数据库
  npx [产品名] start   — 启动生产模式
  npx [产品名] dev     — 启动开发模式
      `);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

```json
// package.json 追加

{
  "bin": {
    "[产品名]": "./cli.ts"
  },
  "files": [
    "cli.ts",
    "app/",
    "lib/",
    "prisma/",
    "components/",
    "public/",
    "next.config.js",
    "package.json"
  ]
}
```

**验收标准：**
```
[ ] npm publish 后可通过 npx [产品名] setup 初始化
[ ] npx [产品名] start 启动项目
[ ] npx [产品名] dev 启动开发模式
```

---

## 第 5-6 周：工作流引擎（W8）

---

### W8：无工作流编排 → 预设工作流 + 简单编辑器

#### 设计思路

不一步到位做拖拽编辑器（研发成本太高），先做**3 个预设工作流模板** + **JSON 配置**，后续再加可视化编辑器。

#### 3 个预设工作流

```
1. Bug Triage 工作流
   触发器: GitHub Webhook (新 Issue) 或 手动触发
   步骤:
     Issue 创建 → AI 分析内容
              → 分类 (bug/feature/question)
              → 评估优先级 (P0/P1/P2)
              → 创建 Kanban 任务
              → 通知负责人

2. 周报生成工作流
   触发器: 定时 (每周五 18:00)
   步骤:
     收集本周任务 → 收集本周消息摘要
                 → AI 生成周报
                 → 发送到 #general
                 → 创建「下周计划」Task

3. 新人入职工作流
   触发器: 手动触发
   步骤:
     创建 #onboarding 频道
     → AI 生成项目背景文档
     → AI 创建 5 个入门 Task
     → AI 发送欢迎消息
```

#### 实现

```typescript
// lib/workflows/types.ts (新文件)

export interface WorkflowStep {
  id: string;
  type: 'ai_analyze' | 'ai_action' | 'approval' | 'notify' | 'condition';
  config: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  trigger: { type: 'webhook' | 'cron' | 'manual'; config: Record<string, unknown> };
  steps: WorkflowStep[];
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: 'running' | 'paused_approval' | 'completed' | 'failed';
  currentStep: number;
  startedAt: Date;
  completedAt?: Date;
  logs: WorkflowLog[];
}
```

```typescript
// lib/workflows/engine.ts (新文件)

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  context: Record<string, unknown>,
): Promise<WorkflowRun> {
  const run = await createRun(workflow.id);

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    await updateRunStep(run.id, i);

    try {
      const result = await executeStep(step, context);
      context = { ...context, [`step_${i}`]: result };

      // 审批步骤: 暂停等待人类决策
      if (step.type === 'approval' && result.status === 'pending') {
        await updateRunStatus(run.id, 'paused_approval');
        return run;
      }
    } catch (err) {
      await updateRunStatus(run.id, 'failed');
      await appendRunLog(run.id, `Step ${i} failed: ${err}`);
      return run;
    }
  }

  await updateRunStatus(run.id, 'completed');
  return run;
}
```

**验收标准：**
```
[ ] 3 个工作流模板可一键启用
[ ] Bug Triage 工作流端到端可运行
[ ] 工作流运行历史可追溯
[ ] JSON 配置可导出/导入
```

---

## 第 7 周：经验积累（W10）

---

### W10：AI 产出不复用 → 经验积累系统

```typescript
// prisma/schema.prisma — 新增

model WorkflowTemplate {
  id          String   @id @default(cuid())
  name        String
  description String?
  definition  Json     // WorkflowDefinition JSON
  createdBy   String
  usageCount  Int      @default(0)
  createdAt   DateTime @default(now())

  @@index([usageCount])
}

model AiMemory {
  id        String   @id @default(cuid())
  aiUserId  String
  type      String   // 'decision' | 'fact' | 'lesson' | 'question'
  content   String   @db.Text
  source    String?  // 引用 Message ID
  createdAt DateTime @default(now())

  @@index([aiUserId, type])
}
```

```typescript
// lib/services/memory.service.ts (新文件)

export async function extractAndStoreMemory(
  aiUserId: string,
  message: string,
): Promise<void> {
  // 调用 AI 判断消息是否含「知识点」
  const analysis = await analyzeMessageForKnowledge(message);

  if (analysis.hasKnowledge) {
    await prisma.aiMemory.create({
      data: {
        aiUserId,
        type: analysis.type,
        content: analysis.content,
        source: analysis.messageId,
      },
    });
  }
}

export async function searchMemory(
  aiUserId: string,
  query: string,
): Promise<string[]> {
  // 简单实现: 关键词匹配
  // 后续可升级为 pgvector embedding 语义搜索
  const memories = await prisma.aiMemory.findMany({
    where: {
      aiUserId,
      content: { contains: query },
    },
    take: 5,
    orderBy: { createdAt: 'desc' },
  });

  return memories.map((m) => m.content);
}
```

**验收标准：**
```
[ ] AI 工作时自动提取知识点
[ ] 知识点可被后续 cycle 检索
[ ] 工作流模板使用次数统计
[ ] 常用工作流自动推荐
```

---

## 📊 弱点修复时间线总览

```
第 1 周 ──────────────────────────────────────────────
  W1: AI 员工管理面板（2天）
       create/update/delete API + 前端 UI
  W2: @AI 即刻触发（0.5天）
       MessageService 检测 @ 名字 → agenticEmitter.wakeup
  W5: reject 审批流程接完（0.5天）
       runtime.ts 监听 reject → 终止 cycle

第 2 周 ──────────────────────────────────────────────
  W3: 真实工具替换（2天）
       Tavily Search + GitHub API + 3 个新工具
  W4: 频道成员管理（2天）
       ChannelMember 表 + API + Socket.io 权限

第 3 周 ──────────────────────────────────────────────
  W6: AI 每日工作报告（1天）
       ReportService + node-cron 18:00
  W7: 多 AI 后端支持（2天）
       Provider 抽象层 + Anthropic Direct 接入

第 4 周 ──────────────────────────────────────────────
  W9: CLI 分发（1天）
       cli.ts + npm bin 配置 + npm publish
  （缓冲 + 测试 + bug 修复）

第 5-6 周 ────────────────────────────────────────────
  W8: 工作流引擎（4天）
       3 个预设模板 + WorkflowEngine + 运行历史

第 7 周 ──────────────────────────────────────────────
  W10: 经验积累系统（2天）
        AiMemory + WorkflowTemplate 统计
  （回归测试 + 文档更新）
```

---

> **下一步：从 W1 开始。两天的开发工作，产出是用户可以创建自己的 AI 员工。**
