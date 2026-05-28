# Launch Day Checklist

上线当天逐项核对，每项都要打 ✅ 才放量。如果某项失败，**先回滚再排查**——不要带着红灯继续往后跑。

预估总时长：30–45 分钟（其中等 AI 30s 响应 + Sentry 上报 ack 各占大头）。

---

## 0. 部署前置（在任何流量进来之前）

### 0.1 ✅ 环境变量全部填写

对照 `.env.example` 在 Railway 控制台 → Variables 页面**逐条**确认（任何一项空着或保留占位都视为 fail）：

**必填且会启动 crash 的变量**（`lib/env.ts` 用 zod 校验，缺/格式错会 `process.exit(1)`）：

| Key                                | 校验规则                                    | 备注                                                      |
| ---------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                     | 非空字符串                                  | Railway 加 PostgreSQL plugin 后会自动注入                 |
| `NEXTAUTH_SECRET`                  | **≥ 32 字符**                                | 用 `openssl rand -base64 48` 重新生成；不要用 example 值 |
| `NEXTAUTH_URL`                     | 非空，有公网 https URL                      | 例：`https://helio.up.railway.app`                        |
| `DEEPSEEK_API_KEY`                 | 以 `sk-` 开头的真实 key                     | 不能保留 `sk-...placeholder` 占位                        |
| `DEEPSEEK_BASE_URL`                | 默认 `https://api.deepseek.com`             | 只在指向自建 OpenAI-compatible 网关时才覆盖              |
| `DEEPSEEK_MODEL`                   | 默认 `deepseek-chat`                        | 切 `deepseek-reasoner` 启用 chain-of-thought 模型        |
| `WORKSPACE_ID`                     | 非空字符串                                  | 默认 `ws_default`，与 seed 必须一致                       |
| `SEED_HUMAN_PASSWORD`              | 强密码（首次部署后立即换掉种子账户密码） | **生产环境必填**——`prisma:seed` 在 `NODE_ENV=production` 下若未设置会拒绝降级到 `password123`，整个 seed step 失败 |

**有默认值但生产强烈建议显式设置**：

| Key                                | 推荐值          | 备注                                                       |
| ---------------------------------- | --------------- | ---------------------------------------------------------- |
| `NODE_ENV`                         | `production`    | 决定 Sentry 是否启用、Next.js 是否走 prod build            |
| `AI_DAILY_BUDGET_USD`              | `5`             | 超过这个数 AI runtime 会熔断并广播一条系统消息            |
| `AI_AGENT_INTERVAL_MS`             | `30000`         | Agentic Loop tick 周期（ms），默认 30 秒                  |
| `AI_INPUT_PRICE_PER_M_USD`         | `1.07`          | DeepSeek 改价时调整；默认对应 2026-05 公布的非缓存命中价 |
| `AI_OUTPUT_PRICE_PER_M_USD`        | `1.10`          | 同上                                                      |
| `AI_BUDGET_EXCEEDED_NOTICE`        | （留空 = 默认中文） | 非中文部署改成本地化文案，无需改代码                     |
| `PORT`                             | Railway 自动注入 | 不要手动写死成 3000                                       |
| `NEXT_PUBLIC_SOCKET_URL`           | 与 NEXTAUTH_URL 同源 | 浏览器端要去连的 Socket.io 地址                           |
| `NEXT_PUBLIC_SOCKET_TRANSPORTS`    | `websocket,polling` | 仅当代理拦 WS 升级时改为 `polling`。**注意**：构建期注入，改动需要 rebuild + redeploy |

**可选（缺失会跳过对应功能而不是 crash）**：

| Key                                                                                                | 启用条件                                       |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `BACKUP_STORAGE_URL`、`BACKUP_BUCKET_NAME`、`BACKUP_ACCESS_KEY_ID`、`BACKUP_SECRET_ACCESS_KEY` | 4 项任缺其一，备份 cron 启动时打 1 行 warn 后跳过 |
| `BACKUP_REGION`                                                                                    | 默认 `auto`（Cloudflare R2）；AWS S3 改 `us-east-1` |
| `NEXT_PUBLIC_SENTRY_DSN`、`SENTRY_ORG`、`SENTRY_PROJECT`                                          | DSN 缺失等于完全关闭 Sentry                    |
| `SENTRY_AUTH_TOKEN`                                                                                | 仅 build 时上传 source maps 用                 |
| `REDIS_URL`                                                                                        | 当前 MVP 未使用；预留给后续任务队列            |

**核对方法**：在 Railway 控制台 → Variables 页面 → Sort by name，对着 `.env.example` 一条一条勾。

---

### 0.2 ✅ `prisma migrate deploy` 执行成功

Railway 的 `startCommand` 已经是 `npx prisma migrate deploy && npx tsx server.ts`，所以这一步会在每次部署 boot 时自动跑。**核对方法**：

1. 部署完成后打开 Railway → Deployments → 最新一次 → Logs。
2. 找到包含 `Applying migration ...` 的行；如果是首次部署应该看到 prisma 列出的所有 migration 文件依次 apply。
3. 紧随其后必须出现 `All migrations have been successfully applied.` 或 `No pending migrations to apply.`。
4. **失败信号**：日志里出现 `Error: P1001`（连不上 DB）/ `P3009`（迁移冲突）→ 立即回滚到上一次 deploy，不要继续。

> **从旧的 `db push` 数据库切换过来？** 第一次会触发 `P3005`（schema 非空但 migration history 空）。
> 启动脚本 (`scripts/railway-start.ts`) **不会自动 baseline**，因为审计发现"自动 baseline 全部目录"会静默跳过新 migration。
> 处理方式：在 Railway 临时设置 `PRISMA_BASELINE_MIGRATIONS=0_init`（只列已经存在于库里的目录），重启一次成功后立即取消该 env。

---

### 0.3 ✅ `/api/admin/budget` 仍然在中间件鉴权之内（不是无 auth）

注意：旧文档说这个端点 "intentional no-auth, internal-only"。现在它在中间件下要求登录返回 JSON 401。如果集群内的 Prometheus / 仪表盘 / sidecar 之前直接 `curl` 这个 URL，**会断**。

应对方案二选一：
- **快速** — 拉一个登录态（用 service account 邮箱 + 密码登录，把 cookie 喂给 scraper）。
- **正确** — 等下个迭代加 Bearer token 兜底（路由文档已经预留，没实装），或者在 K8s NetworkPolicy 层把它限制到内网。

如果你之前没在集群里 curl 这个 endpoint，本节直接打勾。

---

### 0.3 ✅ Seed 数据存在（Ada / Hopper 两个 AI 用户）

迁移成功 ≠ 数据进了。首次部署需要手动跑一次 seed：

```bash
# Railway → 点项目 → Settings → Service → Run Command
npm run prisma:seed
```

预期日志输出（来自 `prisma/seed.ts`）：

```
Seeding workspace "Helio Demo Workspace" (id=ws_default)…
✓ Workspace ws_default (Helio Demo Workspace)
✓ Human user mia@helio.local
✓ Human user dev@helio.local
✓ Human user pm@helio.local
✓ AI colleague Ada (aiRole=Ada)
✓ AI colleague Hopper (aiRole=Hopper)
✓ Channel #general
✓ Channel #engineering
Seed complete.
```

**核对**（用 prisma studio 或一次性 SQL）：

```sql
SELECT name, "isAI", "aiRole" FROM "User" WHERE "isAI" = true;
-- 期望: 2 行 (Ada, Hopper)，aiRole 字段非 null
SELECT name FROM "Channel";
-- 期望: 2 行 (general, engineering)
```

---

## 1. 健康面（流量进来之前最后一道闸）

### 1.1 ✅ `/api/health` 返回 200

```bash
curl -i https://<your-domain>/api/health
```

期望：

```
HTTP/2 200
content-type: application/json
{"ok":true,"ts":1748054400000}
```

Railway 的 `healthcheckPath = /api/health`（见 `railway.toml`），如果这条不绿，部署会一直 stuck 在 "Deploying"。

---

### 1.2 ✅ Socket.io 连接日志显示鉴权通过

打开 https://<your-domain>/login，用 `mia@helio.local` / `password123` 登录。登录成功后浏览器会自动 connect socket.io。

回到 Railway Logs，应该看到 1 条客户端连接 + 0 条 `unauthenticated` 报错。常见信号：

- ✅ 健康：日志里看到 `Socket disconnected` 类条目时，附带 `userId: "..."` 字段（说明握手时 `socket.data.userId` 已填）。
- ❌ 异常：连续刷 `next() with Error: unauthenticated` 或 `next() with Error: SESSION_EXPIRED` —— `NEXTAUTH_SECRET` 不一致（最常见的部署错误：本地用一个 secret，Railway 又生成另一个）。

---

## 2. 业务流冒烟（每条至少跑一次）

> 每一条都用浏览器 `mia@helio.local` / `password123` 登录后做。

### 2.1 ✅ 手动发一条消息，AI 在 35 s 内回复

1. 登录后进 `#general` 频道。
2. 在底部 composer 输入：`@Ada 帮我看看现在有几个 PENDING 任务`，按 Enter。
3. 自己的消息应该 < 1s 出现在 timeline。
4. **核心断言**：35 秒内（Agentic Loop 默认 30s 间隔 + ≤5s 网络）应该出现 Ada 头像旁的 `ai:thinking` 动画，紧接着是一条 Ada 发的回复（紫色竖线 + AI Badge）。

   - 如果超过 35s 没动静：检查 Railway Logs 里有没有 `event: ai_cycle_finished`。
     - 完全没有 → DeepSeek key 没生效（401 在 retry_exhausted 之前就会终止），或 `AI_AGENT_INTERVAL_MS` 写错了。
     - 有 finishReason: 'retry_exhausted' → DeepSeek 限流 / 网络抖动，先看一眼 `/api/admin/budget` 是不是已经熔断。

---

### 2.2 ✅ 手动触发一次审批流程，批准后任务状态更新

最快路径：直接让 AI 触发一次 `request_approval`。在 `#general` 发：

```
@Ada 帮我创建一个高优先级的任务: "上线检查复盘"，但首先 request_approval 让 PM 确认 priority
```

35 秒内：

1. 浏览器右上角应该弹出 ApprovalCenter 的 banner（或 `/` 页面顶部出现审批卡片），文案含 `Approval requested`。
2. 点"批准"。
3. UI 上 banner 消失或状态切换到 APPROVED。
4. 再次 35 秒内，看板（`/board`）上应该出现这个新任务（卡片标题"上线检查复盘"，AI Badge，落在 Backlog 列）。

**回滚式核对**（如果 UI 看不出来）：

```sql
SELECT id, action, status, "decidedById", "decidedAt"
FROM "Approval" ORDER BY "createdAt" DESC LIMIT 5;
-- 期望: 最新一条 status='APPROVED', decidedAt 非 null
SELECT "taskId", title, status, "isAITask"
FROM "Task" ORDER BY "createdAt" DESC LIMIT 5;
-- 期望: 最新 PROJ-{N} 的 isAITask=true, status='Backlog'
```

---

## 3. 监控面（这两条不绿不算上线）

### 3.1 ✅ Sentry 收到至少一条测试 event

如果 `NEXT_PUBLIC_SENTRY_DSN` 已配，最快验证方式是手动触发一次 capture。

**方法 A**（推荐）：临时往 `/api/health/route.ts` 里加一行 `Sentry.captureMessage('launch test')`，部署 → 访问 → 立即删掉这行 → 再部署。

**方法 B**（不改代码）：用 `curl` 直接 POST 到 Sentry 的 ingest endpoint：

```bash
# DSN 拆解后：用 PUBLIC_KEY 和 PROJECT_ID 拼出 store API
curl -X POST "https://<region>.ingest.sentry.io/api/<PROJECT_ID>/store/" \
  -H "X-Sentry-Auth: Sentry sentry_version=7,sentry_key=<PUBLIC_KEY>,sentry_client=launch-checklist/1.0" \
  -H "Content-Type: application/json" \
  -d '{"message":"launch test","level":"info","platform":"javascript"}'
```

**核对**：30 秒内 Sentry → Issues 列表里应该出现 `launch test` 这条。

如果没出现：

- 检查 `NEXT_PUBLIC_SENTRY_DSN` 是不是真实 DSN（不是 `https://xxx@o123.ingest.sentry.io/xxx` 占位）。
- 检查 `NODE_ENV === 'production'`（dev 模式下 client / server / edge config 都把 `enabled` 关掉了）。

---

### 3.2 ✅ Railway 健康检查绿色

Railway 控制台 → Service → Deployments → 最新部署的 status badge 必须是绿色 `Healthy`。

如果是 `Crashed` 或一直 `Deploying`：

- 看 Logs 第一行 → 多半是 `lib/env.ts` 报缺失变量 → 回到 0.1。
- 看 `/api/health` 那一节 → healthcheckTimeout 默认 30s，超过就标 Unhealthy。

---

## 4. 终端体验（不阻断上线，但今天要过一遍）

### 4.1 ✅ 移动端 375 px 基本可用

用 Chrome DevTools → 切到 iPhone SE (375x667) → 访问 https://<your-domain>。逐项打勾：

- [ ] **登录页**：表单字段不溢出，按钮全宽，没有横向滚动条。
- [ ] **登录后首页**：顶部 48 px 高的 MobileHeader 可见（左 ☰ 汉堡 / 中 #channel name / 右 头像），桌面端的 sidebar **默认不展示**（不应该看到 240 px 的固定侧栏）。
- [ ] **打开 sidebar**：点 ☰ → sidebar 从左滑入并覆盖在主内容上方，背后有半透明遮罩；点遮罩或选一个频道后 sidebar 自动关闭。
- [ ] **频道页**：消息列表能正常滚动到最新；MessageComposer 输入框 ≥ 44 px 高（手指点按舒适区），发送按钮变成纸飞机图标。
- [ ] **看板页 `/board`**：4 列 Kanban 不再横排，改为竖向堆叠，每列标题旁边显示任务数量。
- [ ] **审批弹窗**：banner / dialog 不溢出 375 px 视口；批准 / 拒绝按钮可点。

任何一条不绿都不阻断上线（不是关键路径），但记进 backlog 当天补。

---

## 5. 回滚预案

每一项失败的回滚动作：

| 阶段失败                  | 回滚动作                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0.1 / 0.2（boot crash） | Railway → 最新 Deployment → Rollback to Previous。所有 0.x 都不会污染数据，安全。              |
| 0.3（seed 失败）        | seed 是 idempotent（全部 upsert），失败的话**先看 DB 里到底缺哪一行**，再单独 SQL 补；不要重跑全套 seed 把 hash 改了。 |
| 1.x（健康检查不通过）  | 同 0.1，立刻回滚。健康检查不绿等于流量不会路由进来，所以用户感知不到，但要快回滚以释放资源。       |
| 2.x（业务流断）         | **不一定要回滚**：先看 `/api/admin/budget` 是不是已经熔断（pctUsed > 100%）；如果是预算问题，把 `AI_DAILY_BUDGET_USD` 调高就好，不用回滚代码。 |
| 3.x（Sentry 没收到）    | 不阻断上线，标 P1 当天修。                                                                              |
| 4.x（移动端不可用）     | 不阻断上线（移动端不是 MVP 核心），标 P2 第二天修。                                                     |

---

## 6. 上线后第一小时观察清单

每 15 分钟刷一次：

- [ ] Railway Logs 无 `level: error` 的 pino 日志。
- [ ] Sentry Issues 列表 spike 不超过基线 5 倍。
- [ ] `/api/admin/budget` 的 `pctUsed` 变化平滑（不应该 1 小时就烧到 50%）。
- [ ] 至少有 1 个真实用户走完了"登录 → 发消息 → 看到 AI 回复"的链路。
