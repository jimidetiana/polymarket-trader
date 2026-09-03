import assert from 'node:assert/strict'
import test from 'node:test'
import { canSynchronizeOrders } from './order-sync-state.js'

test('empty CLOB responses are successful sync sources, not an API outage', () => {
  // getOpenOrders()=[] and getTradesPaginated()=[] are normal for a wallet with no current activity.
  assert.equal(canSynchronizeOrders({ openOrdersRead: true, tradesRead: true, tradesTruncated: false }), true)
  assert.equal(canSynchronizeOrders({ openOrdersRead: true, tradesRead: false, tradesTruncated: false }), true)
  assert.equal(canSynchronizeOrders({ openOrdersRead: false, tradesRead: true, tradesTruncated: false }), true)
})

test('only a complete CLOB read failure prevents synchronization', () => {
  assert.equal(canSynchronizeOrders({ openOrdersRead: false, tradesRead: false, tradesTruncated: false }), false)
})
