import { createHttpClient } from '../proxy.js'

export type ExchangePosition = {
  tokenId: string
  size: number
  averagePrice: number | null
  currentPrice: number | null
  currentValue: number | null
  title: string | null
  outcome: string | null
}

type PositionRecord = Record<string, unknown>

/** CLOB 下单使用代理钱包时，Data API 也必须查询该账户。 */
export function positionAccount(proxyAddress: string | undefined, walletAddress: string): string {
  return (proxyAddress || walletAddress).toLowerCase()
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function optionalNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function valueAt(record: PositionRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] != null) return record[key]
  }
  return undefined
}

/**
 * Data API 当前返回 asset/size；保留少量别名是为了兼容旧响应，不能把缺少
 * token 或非正余额的记录误报为持仓。
 */
export function parseExchangePositions(payload: unknown): ExchangePosition[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray((payload as { positions?: unknown })?.positions)
        ? (payload as { positions: unknown[] }).positions
        : []

  const byToken = new Map<string, ExchangePosition>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as PositionRecord
    const tokenId = String(valueAt(record, 'asset', 'asset_id', 'token_id', 'tokenId') || '')
    const size = positiveNumber(valueAt(record, 'size', 'currentBalance', 'current_balance', 'quantity'))
    if (!tokenId || !size) continue

    // 一个账户的 Data API 正常每 token 一条；若上游重复返回，不能把它们累加成假仓位。
    byToken.set(tokenId, {
      tokenId,
      size,
      averagePrice: optionalNumber(valueAt(record, 'avgPrice', 'avg_price', 'averagePrice')),
      currentPrice: optionalNumber(valueAt(record, 'curPrice', 'cur_price', 'currentPrice', 'price')),
      currentValue: optionalNumber(valueAt(record, 'currentValue', 'current_value', 'value')),
      title: typeof record.title === 'string' ? record.title : null,
      outcome: typeof record.outcome === 'string' ? record.outcome : null,
    })
  }
  return [...byToken.values()]
}

export async function getExchangePositions(): Promise<ExchangePosition[]> {
  // config 在模块顶层 import 会在加载时就跑 requireEnv，于是仅仅想引用上面那些
  // 纯解析函数（测试就是这么做的）也会因为缺 POLYMARKET_PRIVATE_KEY 而整个文件加载失败。
  // 真正需要凭证的只有这一个函数，所以把它推迟到调用时再读。
  const { config } = await import('../config.js')
  const http = createHttpClient({ baseURL: config.dataUrl, timeout: 15_000 })
  const user = positionAccount(config.proxyAddress, config.walletAddress)
  try {
    const response = await http.get('/positions', { params: { user, sizeThreshold: 0 } })
    return parseExchangePositions(response.data)
  } catch (error: any) {
    const detail = error?.response?.data?.error || error?.message || String(error)
    throw new Error(`Polymarket 持仓读取失败：${detail}`)
  }
}
