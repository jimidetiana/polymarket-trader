# Polymarket API 文档

## Gamma API (公开接口，无需认证)

### Public Profile - 获取用户公开资料

**接口地址**: `GET https://gamma-api.polymarket.com/public-profile`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| address | string | 是 | 钱包地址（EOA 或 代理钱包地址均可） |

**返回字段**:
| 字段 | 类型 | 说明 |
|------|------|------|
| createdAt | string | 账号创建时间 (ISO 8601) |
| proxyWallet | string | 代理钱包地址 |
| displayUsernamePublic | boolean | 是否公开显示用户名 |
| pseudonym | string | 匿名昵称 |
| name | string | 用户名 |
| users | array | 用户列表 |
| users[].id | string | 用户 ID |
| users[].creator | boolean | 是否为创建者 |
| users[].mod | boolean | 是否为版主 |
| users[].communityMod | boolean | 是否为社区版主 |
| verifiedBadge | boolean | 是否有认证徽章 |
| takerTier | number | 吃单者等级 |
| takerTierName | string | 吃单者等级名称 |
| weightedVolume | number | 加权交易量 |

**示例**:
```
GET https://gamma-api.polymarket.com/public-profile?address=0x541619e6e2deeaf026b08a20fb385604969f31be
```

返回:
```json
{
  "createdAt": "2026-08-04T12:58:08.274711Z",
  "proxyWallet": "0x541619e6e2deeaf026b08a20fb385604969f31be",
  "displayUsernamePublic": true,
  "pseudonym": "Whirlwind-Ear",
  "name": "xiaokaNoproblem",
  "users": [
    {
      "id": "9446549",
      "creator": false,
      "mod": false,
      "communityMod": false
    }
  ],
  "verifiedBadge": false,
  "takerTier": 0,
  "takerTierName": "Tier 0",
  "weightedVolume": 0
}
```

**注意**: 如果地址不存在或未注册 Polymarket，返回 404 `profile not found`。

---

## Data API (公开接口，无需认证)

### Positions - 获取用户持仓

**接口地址**: `GET https://data-api.polymarket.com/positions`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user | string | 是 | 钱包地址（小写） |
| sizeThreshold | number | 否 | 最小持仓数量过滤 |

### Value - 获取用户总资产价值

**接口地址**: `GET https://data-api.polymarket.com/value`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user | string | 是 | 钱包地址（小写） |

**返回**:
```json
[
  {
    "user": "0x24a9886579b61c8a32f809f2c7194770939efdd3",
    "value": 0
  }
]
```

### Trades - 获取用户交易历史

**接口地址**: `GET https://data-api.polymarket.com/trades`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user | string | 是 | 钱包地址（小写） |
| limit | number | 否 | 返回数量限制 |

---

## CLOB API (需要 L2 认证)

### Balance Allowance - 查询余额和授权

**接口地址**: `GET https://clob.polymarket.com/balance-allowance`

**认证方式**: L2 (HMAC-SHA256)

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| asset_type | string | 否 | 资产类型，默认 USDC。使用 `COLLATERAL` 查询 Polymarket 内部抵押品余额 |

**L2 签名说明**:
- 签名路径只包含裸路径（不含查询参数），例如：`/balance-allowance`
- 消息格式：`${timestamp}${method}${path}${body}`
- HMAC 密钥：base64 解码 secret 后的字节
- 签名输出：URL-safe base64（保留 padding）

---

## 地址关系说明

Polymarket 地址体系：
1. **EOA 钱包地址** (Signer): 用户的外部钱包地址，用于签名和认证。私钥由用户控制。
2. **代理钱包地址** (Proxy Wallet / Developer Address): Polymarket 部署的智能合约钱包，也是开发者门户中显示的"开发者地址"。
3. 一个 EOA 地址对应一个代理钱包地址。
4. 查询公开资料时，传入 EOA 地址或代理钱包地址都能查到同一用户的信息。

### 查询代理钱包地址
通过 `public-profile` 接口返回的 `proxyWallet` 字段获取。

---

## API Key 类型说明

Polymarket 有两种 API Key，用途不同：

### 1. CLOB API Key (交易 API Key)
- **用途**: 余额查询、下单、撤单等交易操作
- **创建端点**: `GET /auth/derive-api-key` (L1 认证)
- **POLY_ADDRESS**: EOA 签名者地址
- **系统自动派生**: 私钥通过 L1 认证自动派生

### 2. Builder API Key (开发者 API Key)
- **用途**: 开发者费率管理、Builder 交易查询
- **创建端点**: `POST /auth/builder-api-key` (L1 认证)
- **查询端点**: `GET /auth/builder-api-key` (L2 认证)
- **POLY_ADDRESS**: EOA 签名者地址
- **可用端点**: `/builder/trades`, `/fees/builder-fees/` 等
- **不可用于**: `/balance-allowance`, `/order` 等交易端点
- **开发者码**: 开发者门户中显示的 `developer_code`，用于 Builder 专用端点

### Builder 专用端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/builder-api-key` | GET | 列出 Builder API Key (需 L2) |
| `/auth/builder-api-key` | POST | 创建 Builder API Key (需 L1) |
| `/auth/builder-api-key` | DELETE | 吊销 Builder API Key (需 L2) |
| `/builder/trades` | GET | 查询 Builder 交易 (需 L2, 参数 `builder_code`) |
| `/fees/builder-fees/{builder_code}` | GET | 查询 Builder 费率 |
| `/v1/heartbeats` | POST | 发送心跳 (需 L2) |

### 注意事项
- Builder API Key **不能**用于 CLOB 交易端点 (返回 401)
- CLOB API Key **不能**用于 Builder 专用端点
- 两种 Key 需要分别管理，系统当前自动派生 CLOB API Key 用于交易操作
