import type { PrivateKeyAccount } from 'viem/accounts';
import type { ClobClient } from '../api/clob.js';
import { buildLimitOrder } from '../orderBuilder.js';
import { RiskManager } from '../riskManager.js';
import { estimateMarketPrice, getTickPrecision, sleep } from '../utils.js';

interface MarketMakerOptions {
  tokenId: string;
  conditionId?: string;
  orderSize: number;
  maxPosition: number;
  spread: number; // e.g. 0.02 means ±1% around mid
  pollIntervalMs: number;
}

export class SimpleMarketMaker {
  private running = false;
  private readonly risk: RiskManager;

  constructor(
    private readonly clob: ClobClient,
    private readonly signer: PrivateKeyAccount,
    private readonly options: MarketMakerOptions,
  ) {
    this.risk = new RiskManager(clob, options.maxPosition);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[MarketMaker] Starting strategy for token', this.options.tokenId);

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error('[MarketMaker] Tick error:', err);
      }
      await sleep(this.options.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async tick(): Promise<void> {
    const book = await this.clob.getOrderBook(this.options.tokenId);
    if (!book.bids.length || !book.asks.length) {
      console.log('[MarketMaker] No liquidity, skipping');
      return;
    }

    const bestBid = Number(book.bids[0].price);
    const bestAsk = Number(book.asks[0].price);
    const mid = (bestBid + bestAsk) / 2;
    const halfSpread = this.options.spread / 2;

    let bidPrice = mid - halfSpread;
    let askPrice = mid + halfSpread;

    // Keep prices inside the current market to avoid crossing the spread.
    bidPrice = Math.min(bidPrice, bestBid);
    askPrice = Math.max(askPrice, bestAsk);

    const { priceDecimals } = getTickPrecision(book.tick_size);

    // Cancel previous orders for this asset before requoting.
    await this.clob.cancelAllOrders();

    const position = await this.risk.currentPositionSize(this.options.tokenId);

    if (this.risk.canPlaceOrder('BUY', this.options.orderSize, position)) {
      const buy = await buildLimitOrder(
        this.signer,
        this.options.tokenId,
        'BUY',
        bidPrice.toFixed(priceDecimals),
        String(this.options.orderSize),
        book.tick_size,
        book.neg_risk,
        'GTC',
        0,
        true,
      );
      const buyResponse = await this.clob.placeOrder(buy);
      console.log('[MarketMaker] BUY quote:', buyResponse.status, buyResponse.orderID);
    }

    if (this.risk.canPlaceOrder('SELL', this.options.orderSize, position)) {
      const sell = await buildLimitOrder(
        this.signer,
        this.options.tokenId,
        'SELL',
        askPrice.toFixed(priceDecimals),
        String(this.options.orderSize),
        book.tick_size,
        book.neg_risk,
        'GTC',
        0,
        true,
      );
      const sellResponse = await this.clob.placeOrder(sell);
      console.log('[MarketMaker] SELL quote:', sellResponse.status, sellResponse.orderID);
    }
  }
}

export { estimateMarketPrice };
