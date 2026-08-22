import type { ClobClient } from './api/clob.js';

export class RiskManager {
  constructor(
    private readonly clob: ClobClient,
    private readonly maxPosition: number,
  ) {}

  async currentPositionSize(tokenId: string): Promise<number> {
    try {
      const orders = (await this.clob.getOpenOrders({ asset_id: tokenId })) as {
        data: Array<{ side: 'BUY' | 'SELL'; original_size: string; size_matched: string }>;
      };
      let size = 0;
      for (const order of orders.data ?? []) {
        const remaining = Number(order.original_size) - Number(order.size_matched);
        size += order.side === 'BUY' ? remaining : -remaining;
      }
      return size / 1e6;
    } catch {
      return 0;
    }
  }

  canPlaceOrder(side: 'BUY' | 'SELL', size: number, currentPosition: number): boolean {
    const projected = side === 'BUY' ? currentPosition + size : currentPosition - size;
    return Math.abs(projected) <= this.maxPosition;
  }
}
