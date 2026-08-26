import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Market, OrderBook, Outcome, Side } from './types.js';

export const STANDARD_EXCHANGE = '0xE111180000d2663C0091e4f400237545B87B996B';
export const NEG_RISK_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59';
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const CHAIN_ID = 137;

export function exchangeAddress(negRisk: boolean): string {
  return negRisk ? NEG_RISK_EXCHANGE : STANDARD_EXCHANGE;
}

export function urlSafeBase64WithPadding(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function generateSalt(): number {
  // Keep within crypto.randomInt range (2^48) and also below Number.MAX_SAFE_INTEGER.
  return crypto.randomInt(0, 281474976710655);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStringArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseOutcomes(market: Market): Outcome[] {
  if (!market.outcomes) return [];

  const tokenIds = parseStringArray(market.clobTokenIds);

  let raw: unknown = market.outcomes;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: unknown, index: number) => {
      const fallbackTokenId = tokenIds[index];

      if (typeof item === 'string') {
        return { name: item, tokenId: fallbackTokenId };
      }

      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const name =
          typeof obj.name === 'string'
            ? obj.name
            : typeof obj.outcome === 'string'
              ? obj.outcome
              : String(obj.name ?? '');
        const tokenId =
          typeof obj.tokenId === 'string'
            ? obj.tokenId
            : typeof obj.token_id === 'string'
              ? obj.token_id
              : fallbackTokenId;
        return { name, tokenId };
      }

      return { name: String(item), tokenId: fallbackTokenId };
    })
    .filter((o) => o.name && o.name !== 'undefined');
}

interface TickPrecision {
  priceDecimals: number;
  sizeDecimals: number;
  amountDecimals: number;
}

const TICK_TABLE: Record<string, TickPrecision> = {
  '0.1': { priceDecimals: 1, sizeDecimals: 2, amountDecimals: 3 },
  '0.01': { priceDecimals: 2, sizeDecimals: 2, amountDecimals: 4 },
  '0.005': { priceDecimals: 3, sizeDecimals: 2, amountDecimals: 5 },
  '0.0025': { priceDecimals: 4, sizeDecimals: 2, amountDecimals: 6 },
  '0.001': { priceDecimals: 3, sizeDecimals: 2, amountDecimals: 5 },
  '0.0001': { priceDecimals: 4, sizeDecimals: 2, amountDecimals: 6 },
};

export function getTickPrecision(tickSize: string): TickPrecision {
  const precision = TICK_TABLE[tickSize];
  if (!precision) {
    // Sensible fallback for the common 0.01 tick.
    return { priceDecimals: 2, sizeDecimals: 2, amountDecimals: 4 };
  }
  return precision;
}

export function round(value: Decimal.Value, decimals: number, mode: Decimal.Rounding): string {
  return new Decimal(value).toFixed(decimals, mode);
}

export function toAtomic(value: Decimal.Value, decimals = 6): bigint {
  const scaled = new Decimal(value).mul(new Decimal(10).pow(decimals));
  return BigInt(scaled.toFixed(0, Decimal.ROUND_DOWN));
}

export function fromAtomic(value: bigint | string, decimals = 6): string {
  return new Decimal(value.toString()).div(new Decimal(10).pow(decimals)).toString();
}

export function encodeLimitAmounts(
  side: Side,
  price: string,
  size: string,
  tickSize: string,
): { makerAmount: bigint; takerAmount: bigint } {
  const { priceDecimals, sizeDecimals, amountDecimals } = getTickPrecision(tickSize);

  const roundedPrice = round(price, priceDecimals, Decimal.ROUND_HALF_UP);
  const roundedSize = round(size, sizeDecimals, Decimal.ROUND_DOWN);

  const usdAmount = new Decimal(roundedPrice).mul(new Decimal(roundedSize));
  // Round the USD/quote amount per the Polymarket precision guide.
  const roundedUsd = round(usdAmount, amountDecimals, Decimal.ROUND_DOWN);

  if (side === 'BUY') {
    return {
      makerAmount: toAtomic(roundedUsd),
      takerAmount: toAtomic(roundedSize),
    };
  }
  return {
    makerAmount: toAtomic(roundedSize),
    takerAmount: toAtomic(roundedUsd),
  };
}

export function encodeMarketAmounts(
  side: Side,
  price: string,
  amount: string, // USD notional for BUY, shares for SELL
  tickSize: string,
): { makerAmount: bigint; takerAmount: bigint } {
  const { priceDecimals, sizeDecimals, amountDecimals } = getTickPrecision(tickSize);

  if (side === 'BUY') {
    const usd = round(amount, sizeDecimals, Decimal.ROUND_DOWN);
    const roundedPrice = round(price, priceDecimals, Decimal.ROUND_DOWN);
    const shares = new Decimal(usd).div(new Decimal(roundedPrice));
    const roundedShares = round(shares, amountDecimals, Decimal.ROUND_UP);
    return {
      makerAmount: toAtomic(usd),
      takerAmount: toAtomic(roundedShares),
    };
  }

  const shares = round(amount, sizeDecimals, Decimal.ROUND_DOWN);
  const roundedPrice = round(price, priceDecimals, Decimal.ROUND_DOWN);
  const usd = new Decimal(shares).mul(new Decimal(roundedPrice));
  const roundedUsd = round(usd, amountDecimals, Decimal.ROUND_UP);
  return {
    makerAmount: toAtomic(shares),
    takerAmount: toAtomic(roundedUsd),
  };
}

export function estimateMarketPrice(
  book: OrderBook,
  side: Side,
  amount: string,
): string {
  const levels = side === 'BUY' ? book.asks : book.bids;
  if (!levels.length) {
    throw new Error(`No ${side === 'BUY' ? 'ask' : 'bid'} liquidity available`);
  }

  if (side === 'BUY') {
    let remaining = new Decimal(amount);
    let lastPrice = new Decimal(levels[0].price);
    for (const level of levels) {
      const levelValue = new Decimal(level.price).mul(new Decimal(level.size));
      if (remaining.lte(levelValue)) {
        return level.price;
      }
      remaining = remaining.sub(levelValue);
      lastPrice = new Decimal(level.price);
    }
    return lastPrice.toString();
  }

  let remaining = new Decimal(amount);
  let lastPrice = new Decimal(levels[0].price);
  for (const level of levels) {
    if (remaining.lte(new Decimal(level.size))) {
      return level.price;
    }
    remaining = remaining.sub(new Decimal(level.size));
    lastPrice = new Decimal(level.price);
  }
  return lastPrice.toString();
}
