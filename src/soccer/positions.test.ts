import assert from 'node:assert/strict'
import test from 'node:test'
import { parseExchangePositions, positionAccount } from './positions.js'

test('position account prefers the proxy wallet used by CLOB orders', () => {
  assert.equal(
    positionAccount('0xProxy', '0xWallet'),
    '0xproxy',
  )
  assert.equal(positionAccount(undefined, '0xWallet'), '0xwallet')
})

test('Data API positions retain only positive token balances', () => {
  const positions = parseExchangePositions([
    { asset: 'token-a', size: 5, avgPrice: 0.42, curPrice: 0.5, currentValue: 2.5, title: 'A', outcome: 'Yes' },
    { asset: 'zero', size: 0 },
    { asset: 'negative', size: -1 },
    { asset: 'missing-size' },
  ])

  assert.deepEqual(positions, [{
    tokenId: 'token-a',
    size: 5,
    averagePrice: 0.42,
    currentPrice: 0.5,
    currentValue: 2.5,
    title: 'A',
    outcome: 'Yes',
  }])
})

test('duplicate Data API entries do not get summed into a fake position', () => {
  const positions = parseExchangePositions({ data: [
    { asset: 'token-a', size: 2 },
    { asset: 'token-a', size: 3 },
  ] })

  assert.equal(positions.length, 1)
  assert.equal(positions[0].size, 3)
})
