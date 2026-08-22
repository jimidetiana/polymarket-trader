# Polymarket 足球交易项目接口文档

本文档汇总项目内所有对外的 HTTP/WebSocket 接口，包括后端自研 API、Polymarket Gamma API、Polymarket CLOB API 和实时数据 WebSocket。

---

## 一、后端自研 API

基础地址：`http://localhost:3000`

### 1.1 获取比赛列表

```
GET /api/soccer/events
```

**返回信息**

```json
{
  "success": true,
  "count": 60,
  "events": [
    {
      "id": "805462",
      "slug": "soccer-2026-08-19-coban-imperial-vs-antigua-gfc",
      "title_en": "CSD Cobán Imperial vs. Antigua GFC",
      "title_zh": "科班皇家 vs 安提瓜",
      "league": "危地马拉甲级联赛",
      "home_team_en": "CSD Cobán Imperial",
      "away_team_en": "Antigua GFC",
      "home_team_zh": "科班皇家",
      "away_team_zh": "安提瓜",
      "start_time": "2026-08-19T10:15:16.000Z",
      "end_time": "2026-08-19T21:00:00.000Z",
      "volume": 125000.5,
      "liquidity": 45000.25,
      "event_status": "active",
      "match_status": "ended",
      "markets": [
        {
          "id": "2127663",
          "event_id": "805462",
          "question_en": "Will CSD Cobán Imperial win?",
          "question_zh": "科班皇家会获胜吗？",
          "market_type": "main",
          "line": null,
          "outcomes": ["Yes", "No"],
          "outcomes_zh": ["是", "否"],
          "outcome_prices": [0.65, 0.35],
          "clob_token_ids": [
            "21951226365672068827661744318172031673826847800195287086261597082166870538740",
            "33896607823388600558222421347266613674976673770405419631622989961143438148884"
          ],
          "volume": 125000.5,
          "liquidity": 45000.25,
          "best_bid": 0.64,
          "best_ask": 0.66,
          "market_status": "active"
        }
      ]
    }
  ]
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | Polymarket event ID |
| `slug` | string | 事件 slug |
| `title_en` / `title_zh` | string | 英文/中文赛事标题 |
| `league` | string | 联赛名称（中文） |
| `home_team_en` / `home_team_zh` | string | 主队英文/中文 |
| `away_team_en` / `away_team_zh` | string | 客队英文/中文 |
| `start_time` | string (ISO) | 事件创建/开始时间 |
| `end_time` | string (ISO) | 比赛开球时间（UTC） |
| `volume` | number | 交易量 |
| `liquidity` | number | 流动性 |
| `event_status` | string | `active` / `closed` |
| `match_status` | string | `not_started` / `live` / `ended` |
| `markets` | array | 该比赛下所有盘口 |

---

### 1.2 手动刷新比赛数据

```
POST /api/soccer/refresh
```

**返回信息**

```json
{
  "success": true,
  "message": "刷新完成",
  "events": [
    { "id": "805462", "title_en": "CSD Cobán Imperial vs. Antigua GFC" }
  ]
}
```

---

### 1.3 获取比赛盘口

```
GET /api/soccer/events/:id/markets
```

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 比赛 event ID |

**返回信息**

```json
{
  "success": true,
  "markets": [
    {
      "id": "2127663",
      "event_id": "805462",
      "question_en": "Will CSD Cobán Imperial win?",
      "question_zh": "科班皇家会获胜吗？",
      "market_type": "main",
      "outcomes": ["Yes", "No"],
      "outcomes_zh": ["是", "否"],
      "outcome_prices": [0.65, 0.35],
      "clob_token_ids": ["...", "..."],
      "best_bid": 0.64,
      "best_ask": 0.66,
      "market_status": "active"
    }
  ]
}
```

---

### 1.4 获取盘口深度

```
GET /api/soccer/orderbook/:tokenId
```

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `tokenId` | string | CLOB token ID（asset ID） |

**返回信息**

```json
{
  "success": true,
  "book": {
    "market": "0x50561f0ac9fb48ce9b1dc8f78f84dea5e43d9d30bd507eb93fa57b11a996ffeb",
    "asset_id": "3488261232009523381576281256634840719226792569353110860105294590188599877555",
    "timestamp": "1787296459337",
    "hash": "f0828551228a4357dea0e153e52e0d174e358518",
    "bids": [
      { "price": "0.01", "size": "78.4" }
    ],
    "asks": [
      { "price": "0.81", "size": "120.5" }
    ],
    "min_order_size": "1",
    "tick_size": "0.01",
    "neg_risk": false,
    "last_trade_price": "0.45"
  }
}
```

**错误返回**

```json
{
  "success": false,
  "error": "No orderbook exists for the requested token id"
}
```

---

### 1.5 提交订单

```
POST /api/soccer/orders
```

**请求体**

```json
{
  "market_id": "2127663",
  "token_id": "21951226365672068827661744318172031673826847800195287086261597082166870538740",
  "side": "BUY",
  "size": 10,
  "price": 0.65
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `market_id` | string | 盘口 ID |
| `token_id` | string | CLOB token ID |
| `side` | string | `BUY` / `SELL` |
| `size` | number | 数量 |
| `price` | number | 价格（0-1 美元） |

**返回信息**

```json
{
  "success": true,
  "orderId": "12345",
  "message": "下单请求已记录，待实盘接入后执行"
}
```

---

### 1.6 获取订单列表

```
GET /api/soccer/orders
```

**返回信息**

```json
{
  "success": true,
  "orders": [
    {
      "id": 1,
      "market_id": "2127663",
      "token_id": "21951226365672068827661744318172031673826847800195287086261597082166870538740",
      "side": "BUY",
      "size": 10,
      "price": 0.65,
      "order_status": "pending",
      "memo": "界面下单（待实盘接入）",
      "created_at": "2026-08-21T05:30:00.000Z"
    }
  ]
}
```

---

### 1.7 获取翻译列表

```
GET /api/soccer/translations
```

**返回信息**

```json
{
  "success": true,
  "count": 60,
  "events": [
    {
      "id": "805462",
      "title_en": "CSD Cobán Imperial vs. Antigua GFC",
      "title_zh": "科班皇家 vs 安提瓜",
      "home_team_zh": "科班皇家",
      "away_team_zh": "安提瓜",
      "league": "危地马拉甲级联赛"
    }
  ]
}
```

---

### 1.8 保存比赛翻译

```
POST /api/soccer/translations
```

**请求体**

```json
{
  "id": "805462",
  "title_zh": "科班皇家 vs 安提瓜",
  "home_team_zh": "科班皇家",
  "away_team_zh": "安提瓜",
  "league": "危地马拉甲级联赛"
}
```

**返回信息**

```json
{
  "success": true,
  "message": "比赛信息已保存"
}
```

---

### 1.9 获取未翻译比赛

```
GET /api/soccer/untranslated?limit=50
```

**查询参数**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `limit` | number | 50 | 返回数量上限 |

**返回信息**

```json
{
  "success": true,
  "count": 10,
  "events": [ ]
}
```

---

### 1.10 批量导入翻译

```
POST /api/soccer/translations/import
```

**请求体**

```json
{
  "events": [
    {
      "id": "805462",
      "title_zh": "科班皇家 vs 安提瓜",
      "home_team_zh": "科班皇家",
      "away_team_zh": "安提瓜",
      "league": "危地马拉甲级联赛",
      "markets": [
        {
          "id": "2127663",
          "question_zh": "科班皇家会获胜吗？",
          "outcomes_zh": ["是", "否"]
        }
      ]
    }
  ]
}
```

**返回信息**

```json
{
  "success": true,
  "message": "已导入 1 条比赛翻译"
}
```

---

### 1.11 保存盘口翻译

```
POST /api/soccer/markets/:id
```

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 盘口 ID |

**请求体**

```json
{
  "question_zh": "科班皇家会获胜吗？",
  "outcomes_zh": ["是", "否"]
}
```

**返回信息**

```json
{
  "success": true,
  "message": "盘口信息已保存"
}
```

---

## 二、Polymarket Gamma API

基础地址：`https://gamma-api.polymarket.com`

用于获取赛事元数据、盘口列表和初始价格。

### 2.1 获取事件列表

```
GET /events
```

**常用查询参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `tag_id` | number | 1 表示足球 |
| `active` | boolean | 是否活跃 |
| `closed` | boolean | 是否已关闭 |
| `limit` | number | 分页大小 |
| `offset` | number | 分页游标 |

**返回信息（节选）**

```json
[
  {
    "id": "805462",
    "title": "CSD Cobán Imperial vs. Antigua GFC",
    "description": "scheduled for Wednesday, August 19, 2026",
    "startDate": "2026-08-06T10:15:16Z",
    "endDate": "2026-08-19T21:00:00Z",
    "active": true,
    "closed": true,
    "tags": [
      { "id": 1, "slug": "soccer", "label": "Soccer" }
    ],
    "markets": [
      {
        "id": "2127663",
        "question": "Will CSD Cobán Imperial win?",
        "conditionId": "0x50561f0ac9fb48ce9b1dc8f78f84dea5e43d9d30bd507eb93fa57b11a996ffeb",
        "outcomes": ["Yes", "No"],
        "outcomePrices": ["0.65", "0.35"],
        "clobTokenIds": [
          "21951226365672068827661744318172031673826847800195287086261597082166870538740"
        ],
        "volume": "125000.5",
        "liquidity": "45000.25",
        "active": true,
        "closed": false
      }
    ]
  }
]
```

---

## 三、Polymarket CLOB API

基础地址：`https://clob.polymarket.com`

用于获取盘口深度、下单、查询订单等。

### 3.1 获取盘口深度

```
GET /book?token_id={tokenId}
```

**查询参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `token_id` | string | CLOB token ID |

**返回信息**

```json
{
  "market": "0x50561f0ac9fb48ce9b1dc8f78f84dea5e43d9d30bd507eb93fa57b11a996ffeb",
  "asset_id": "3488261232009523381576281256634840719226792569353110860105294590188599877555",
  "timestamp": "1787296459337",
  "hash": "f0828551228a4357dea0e153e52e0d174e358518",
  "bids": [
    { "price": "0.01", "size": "78.4" }
  ],
  "asks": [
    { "price": "0.81", "size": "120.5" }
  ],
  "min_order_size": "1",
  "tick_size": "0.01",
  "neg_risk": false,
  "last_trade_price": "0.45"
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `market` | string | 市场条件 ID（合约地址） |
| `asset_id` | string | Token ID |
| `timestamp` | string | 快照时间戳（毫秒） |
| `hash` | string | 订单簿摘要哈希 |
| `bids` | array | 买单列表，按价格降序 |
| `asks` | array | 卖单列表，按价格升序 |
| `min_order_size` | string | 最小下单数量 |
| `tick_size` | string | 最小价格精度 |
| `neg_risk` | boolean | 是否为负风险市场 |
| `last_trade_price` | string | 最新成交价 |

---

### 3.2 下单（需签名认证）

```
POST /order
```

**请求头**

```
POLYMARKET_API_KEY: {api_key}
POLYMARKET_API_SECRET: {secret}
POLYMARKET_API_PASSPHRASE: {passphrase}
```

**请求体**

```json
{
  "order": {
    "salt": "1234567890",
    "maker": "0x...",
    "signer": "0x...",
    "taker": "0x0000000000000000000000000000000000000000",
    "tokenId": "3488261232009523381576281256634840719226792569353110860105294590188599877555",
    "makerAmount": "10000000",
    "takerAmount": "8100000",
    "expiration": "0",
    "nonce": "1234567890",
    "feeRateBps": "0",
    "side": "BUY",
    "signatureType": 0,
    "signature": "0x..."
  },
  "owner": "0x...",
  "orderType": "GTC"
}
```

**返回信息**

```json
{
  "orderID": "...",
  "market": "0x...",
  "asset_id": "...",
  "status": "OPEN"
}
```

> 注：当前项目前端仅将订单记录到本地 MySQL，实盘下单需接入钱包签名。

---

## 四、WebSocket 实时数据

### 4.1 CLOB 价格 WebSocket

地址：`wss://ws-subscriptions-clob.polymarket.com/ws/market`

**订阅消息**

```json
{
  "type": "market",
  "assets_ids": [
    "3488261232009523381576281256634840719226792569353110860105294590188599877555"
  ]
}
```

**价格变化消息**

```json
{
  "event_type": "price_change",
  "price_changes": [
    {
      "asset_id": "3488261232009523381576281256634840719226792569353110860105294590188599877555",
      "best_bid": "0.64",
      "best_ask": "0.66"
    }
  ]
}
```

**最佳买卖价消息**

```json
{
  "event_type": "best_bid_ask",
  "asset_id": "3488261232009523381576281256634840719226792569353110860105294590188599877555",
  "best_bid": "0.64",
  "best_ask": "0.66"
}
```

**心跳**

- 客户端每 10 秒发送 `"PING"`
- 服务端回复 `"PONG"`

---

## 五、数据库表结构

### soccer_events

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT PK | Polymarket event ID |
| `slug` | VARCHAR(255) | 事件 slug |
| `title_en` / `title_zh` | VARCHAR(500) | 英文/中文标题 |
| `league` | VARCHAR(120) | 联赛 |
| `home_team_en` / `home_team_zh` | VARCHAR(200) | 主队 |
| `away_team_en` / `away_team_zh` | VARCHAR(200) | 客队 |
| `start_time` / `end_time` | DATETIME | 开始/开球时间 |
| `volume` / `liquidity` | DECIMAL(24,8) | 交易量/流动性 |
| `event_status` | VARCHAR(20) | active / closed |

### soccer_markets

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT PK | Polymarket market ID |
| `event_id` | BIGINT FK | 所属比赛 |
| `question_en` / `question_zh` | VARCHAR(500) | 英文/中文盘口问题 |
| `market_type` | VARCHAR(50) | 盘口类型 |
| `outcomes` | JSON | 结果选项 |
| `outcome_prices` | JSON | 结果价格 |
| `clob_token_ids` | JSON | CLOB token IDs |
| `best_bid` / `best_ask` | DECIMAL(8,4) | 最佳买卖价 |

### soccer_orders

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT PK AI | 自增 ID |
| `market_id` / `token_id` | BIGINT / VARCHAR | 盘口和 token |
| `side` | ENUM | BUY / SELL |
| `size` / `price` | DECIMAL | 数量和价格 |
| `order_status` | VARCHAR(30) | 订单状态 |
| `memo` | VARCHAR(500) | 备注 |
