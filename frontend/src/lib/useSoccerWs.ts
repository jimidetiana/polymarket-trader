import { useEffect, useRef, useState, useCallback } from 'react'
import type { LivePrice, OrderBook, WsStatus } from '@/types'

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/market`

function parseBookSide(
  side?: Array<{ price: number | string; size?: number | string }>,
  sortOrder?: 'asc' | 'desc',
): Array<{ price: number; size: number }> {
  if (!Array.isArray(side)) return []
  const result = side
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size ?? 0),
    }))
    .filter((level) => !isNaN(level.price) && level.price > 0)
  if (sortOrder === 'asc') result.sort((a, b) => a.price - b.price)
  else if (sortOrder === 'desc') result.sort((a, b) => b.price - a.price)
  return result
}

export function useSoccerWs(tokenIds: string[]) {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({})
  const [orderBooks, setOrderBooks] = useState<Record<string, OrderBook>>({})
  const [status, setStatus] = useState<WsStatus>('idle')
  const wsRef = useRef<WebSocket | null>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const disconnect = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current)
      pingRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setStatus('idle')
  }, [])

  useEffect(() => {
    const ids = tokenIds.filter(Boolean)
    if (!ids.length) {
      disconnect()
      setPrices({})
      setOrderBooks({})
      return
    }

    setStatus('connecting')
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('open')
      ws.send(
        JSON.stringify({
          type: 'market',
          assets_ids: ids,
          custom_feature_enabled: true,
        }),
      )
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING')
      }, 10000)
    }

    ws.onmessage = (event) => {
      if (event.data === 'PONG') return
      try {
        const data = JSON.parse(event.data)
        // Polymarket market channel sends arrays of book objects
        if (Array.isArray(data)) {
          for (const item of data) {
            handleWsMessage(item)
          }
        } else {
          handleWsMessage(data)
        }
      } catch {
        // ignore malformed messages
      }
    }

    // On a dropped/failed connection, discard the last snapshot. Keeping it
    // would render a frozen book that still looks live.
    ws.onerror = () => {
      setStatus('error')
      setOrderBooks({})
    }
    ws.onclose = () => {
      setStatus('closed')
      setOrderBooks({})
      if (pingRef.current) {
        clearInterval(pingRef.current)
        pingRef.current = null
      }
    }

    function handleWsMessage(msg: any) {
      const priceUpdates: Record<string, LivePrice> = {}
      const bookUpdates: Record<string, OrderBook> = {}

      // Market channel: book snapshot without event_type
      if (msg.asset_id && (msg.bids || msg.asks) && !msg.event_type) {
        const bids = parseBookSide(msg.bids, 'desc')
        const asks = parseBookSide(msg.asks, 'asc')
        priceUpdates[msg.asset_id] = {
          bid: bids[0]?.price ?? null,
          ask: asks[0]?.price ?? null,
        }
        bookUpdates[msg.asset_id] = { bids, asks }
      } else if (msg.event_type === 'book' && msg.asset_id) {
        const bids = parseBookSide(msg.bids, 'desc')
        const asks = parseBookSide(msg.asks, 'asc')
        priceUpdates[msg.asset_id] = {
          bid: bids[0]?.price ?? null,
          ask: asks[0]?.price ?? null,
        }
        bookUpdates[msg.asset_id] = { bids, asks }
      } else if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
        for (const pc of msg.price_changes) {
          const bid = pc.best_bid !== undefined ? Number(pc.best_bid) : null
          const ask = pc.best_ask !== undefined ? Number(pc.best_ask) : null
          priceUpdates[pc.asset_id] = { bid, ask }
        }
      } else if (msg.event_type === 'best_bid_ask' && msg.asset_id) {
        const bid = msg.best_bid !== undefined ? Number(msg.best_bid) : null
        const ask = msg.best_ask !== undefined ? Number(msg.best_ask) : null
        priceUpdates[msg.asset_id] = { bid, ask }
      }

      if (Object.keys(priceUpdates).length) {
        setPrices((prev) => ({ ...prev, ...priceUpdates }))
      }
      if (Object.keys(bookUpdates).length) {
        setOrderBooks((prev) => ({ ...prev, ...bookUpdates }))
      }
    }

    return () => {
      disconnect()
    }
  }, [tokenIds.join(','), disconnect])

  return { prices, orderBooks, status }
}
