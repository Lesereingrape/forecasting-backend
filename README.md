# Forecasting Backend 账户预测系统

一个简化版预测/下注系统后端，用于演示账户余额管理、幂等请求、下注状态机、追加式账本和后台对账机制。

本项目面向后端技术测验交付，重点不是 UI 展示，而是核心业务一致性和边界情况处理。

## 项目能力概览

| 模块 | 能力 | 关键约束 |
| --- | --- | --- |
| 用户账户 | 静态用户、余额查询基础数据 | 用户由初始化脚本预置，不通过接口动态创建 |
| 充值 | 用户余额增加、写入充值账本 | 支持 `Idempotency-Key`，重复请求只生效一次 |
| 下注 | 扣减余额、创建下注订单、写入扣款账本 | 余额不足失败；并发下注不能导致负余额 |
| 状态机 | `PLACED -> SETTLED` / `PLACED -> CANCELLED` | `SETTLED`、`CANCELLED` 为终态 |
| 结算 | WIN 发奖、LOSE 不返还 | 已结算/已取消订单不可重复处理 |
| 取消 | 仅允许取消 `PLACED` 订单并退款 | 退款必须写入账本 |
| 对账 | 比较数据库余额与账本推导余额 | 检测缺少扣款、重复结算、退款缺失等异常 |

## 技术栈

- Node.js + TypeScript
- Express
- SQLite + Prisma
- Vitest + Supertest

## 快速运行

```bash
npm install
copy .env.example .env
npm run db:init
npm run dev
```

默认服务地址：

```text
http://localhost:3000
```

健康检查：

```http
GET /health
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run db:init` | 初始化 SQLite 表结构并写入静态用户 |
| `npm run dev` | 启动开发服务 |
| `npm test` | 运行自动化测试 |
| `npm run build` | TypeScript 构建检查 |

## 目录结构

```text
.
|-- prisma
|   |-- schema.prisma      # Prisma 数据模型
|   |-- initDb.ts          # SQLite 初始化和静态用户种子
|   `-- seed.ts            # Prisma seed 入口
|-- src
|   |-- app.ts             # Express 路由和错误响应
|   |-- db.ts              # Prisma Client
|   |-- dbSchema.ts        # SQLite 表结构初始化
|   `-- services           # 核心业务逻辑
|       |-- betService.ts
|       |-- idempotencyService.ts
|       |-- ledgerService.ts
|       |-- reconcileService.ts
|       `-- userService.ts
`-- tests
    |-- app.test.ts        # API 和业务边界测试
    `-- setup.ts
```

## 数据模型

### User

静态预置用户。

核心字段：

- `id`
- `username`
- `balance`
- `createdAt`

### Bet

下注订单。

状态枚举：

- `PLACED`
- `SETTLED`
- `CANCELLED`

允许流转：

```text
PLACED -> SETTLED
PLACED -> CANCELLED
```

`SETTLED` 和 `CANCELLED` 是终态，不允许再次结算、取消或退款。

### LedgerEntry

追加式账本。业务代码只追加新账本记录，不修改历史账务记录。

账本类型：

- `DEPOSIT`: 用户充值成功
- `BET_DEBIT`: 用户下单扣费
- `BET_CREDIT`: WIN 结算发奖
- `BET_REFUND`: 取消订单退款

余额推导规则：

```text
calculatedBalance = DEPOSIT - BET_DEBIT + BET_CREDIT + BET_REFUND
```

### IdempotencyRecord

幂等请求记录。

记录内容：

- `scope`
- `Idempotency-Key`
- 请求体 hash
- 首次响应状态码
- 首次响应 body

## API 说明

### 充值

```http
POST /api/users/:id/deposit
Idempotency-Key: <string>
Content-Type: application/json

{ "amount": 200 }
```

成功响应：

```json
{
  "userId": 1,
  "balance": 1200,
  "ledgerEntryId": 2
}
```

规则：

- `amount` 必须是正整数。
- 成功后增加余额并写入 `DEPOSIT` 账本。
- 相同 `Idempotency-Key` 重复请求只生效一次。
- 相同 key 但请求体不同，返回 `409 Conflict`。

### 下注

```http
POST /api/bets
Idempotency-Key: <string>
Content-Type: application/json

{ "userId": 1, "gameId": "game-a", "amount": 100 }
```

规则：

- `amount` 必须是正整数。
- 余额不足返回 `409 Conflict`。
- 成功后扣减余额、创建 `PLACED` 订单、写入 `BET_DEBIT` 账本。
- 支持幂等处理。
- 扣款使用 `balance >= amount` 条件更新，避免并发下注导致负余额。

### 结算

```http
POST /api/bets/:id/settle
Content-Type: application/json

{ "result": "WIN" }
```

规则：

- `result` 只能是 `WIN` 或 `LOSE`。
- 仅允许 `PLACED -> SETTLED`。
- `WIN` 入账 `2 * amount`，表示返还本金并发放同额盈利。
- `LOSE` 不返还余额。
- 状态更新使用 `id + status = PLACED` 条件更新，避免并发重复结算。

### 取消

```http
POST /api/bets/:id/cancel
```

规则：

- 仅允许 `PLACED -> CANCELLED`。
- 成功后退款并写入 `BET_REFUND` 账本。
- 已结算或已取消订单返回 `409 Conflict`。

### 对账

```http
GET /api/admin/reconcile?userId=1
```

返回内容：

- `storedBalance`: 当前数据库记录余额。
- `calculatedBalance`: 账本推导余额。
- `betStatusCounts`: 各状态订单统计。
- `anomalies`: 异常列表。

异常检测包括：

- 缺少下注扣款记录。
- 重复结算发奖。
- 重复退款。
- 取消订单缺少退款。
- 非取消订单出现退款。
- 未结算订单出现发奖。
- 数据库余额与账本推导余额不一致。

## 核心设计

### 幂等性

充值和下注接口都要求 `Idempotency-Key`。系统使用 `scope + key` 定位幂等记录，并保存请求体 hash。

处理策略：

- 首次请求：执行业务逻辑并保存响应。
- 重复相同请求：返回首次响应，并带上 `Idempotency-Replayed: true`。
- 相同 key 但请求体不同：返回 `409 Conflict`。

### 状态机

下注状态流转集中在 `betService` 中实现。

- 结算只能从 `PLACED` 进入 `SETTLED`。
- 取消只能从 `PLACED` 进入 `CANCELLED`。
- 终态不可重复变更。
- 并发结算/取消通过条件状态更新兜底。

### 账本一致性

所有余额变化都和账本写入放在同一个 Prisma transaction 中。

| 场景 | 同一事务内完成 |
| --- | --- |
| 充值 | 余额增加 + `DEPOSIT` |
| 下注 | 条件扣款 + 创建 Bet + `BET_DEBIT` |
| WIN 结算 | 条件状态更新 + 余额增加 + `BET_CREDIT` |
| 取消 | 条件状态更新 + 余额退款 + `BET_REFUND` |

数据库层还对 `betId + type` 设置唯一约束，防止同一订单重复写入相同类型账本。

## 质量保障

| 评分重点 | 当前实现 |
| --- | --- |
| 幂等性严谨度 | 请求体 hash 校验；重复请求返回首次响应；冲突返回 409 |
| 状态机严谨度 | 状态流转集中实现；终态不可变更；条件更新防并发重复流转 |
| 账本一致性 | append-only 账本；余额变化和账本写入同事务完成 |
| 事务处理 | 充值、下注、结算、取消均使用 Prisma transaction |
| 边界情况 | 覆盖余额不足、重复结算、取消后结算、并发下注、并发结算 |
| 测试覆盖 | 12 个 Vitest/Supertest 测试用例 |

## 测试覆盖

当前测试用例数量：12 个。

覆盖作业要求的 6 个核心用例：

- 充值成功后余额正确增加。
- 充值幂等，多次请求只生效一次。
- 余额不足下注失败。
- 下注幂等，多次请求只创建一个订单。
- WIN 结算后余额正确增加。
- 已结算订单不允许重复结算。

除基础 6 个用例外，额外覆盖以下独立边界场景：

- 幂等 key 被不同请求体复用时返回 `409`。
- 取消订单退款正确。
- 已取消订单不可结算。
- 并发下注防透支。
- 并发结算防重复发奖。

另有 1 个对账接口校验用例，用于确认正常账本下 `storedBalance` 与 `calculatedBalance` 一致，并返回订单状态统计和 `anomalies` 字段。

## 交付说明

本项目保持轻量后端结构，没有引入前端页面、发布下载、社区贡献流程等开源产品型内容。README 重点围绕运行、接口、数据一致性、边界处理和测试覆盖展开，便于评审快速核对作业要求。
