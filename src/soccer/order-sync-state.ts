/**
 * 同步数据源的读取状态。
 *
 * 注意：数组为空仍然是请求成功。把空列表等同于 API 不可用，会让本地 open
 * 订单永远跳过 getOrder() 精确复核，状态也就永远不会回写。
 */
export type OrderSyncSourceState = {
  openOrdersRead: boolean
  tradesRead: boolean
  tradesTruncated: boolean
}

/** 至少有一个交易所数据源成功读取，才可以尝试核验本地订单。 */
export function canSynchronizeOrders(state: OrderSyncSourceState): boolean {
  return state.openOrdersRead || state.tradesRead
}
