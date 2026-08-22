export type Side = 'BUY' | 'SELL';
export type OrderType = 'GTC' | 'GTD' | 'FAK' | 'FOK';

export interface ClobCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface OrderBook {
  asset_id: string;
  market: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  min_order_size: string;
  tick_size: string;
  neg_risk: boolean;
}

export interface SignedOrder {
  order: {
    maker: string;
    signer: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    side: Side;
    expiration: string;
    timestamp: string;
    metadata: string;
    builder: string;
    signature: string;
    salt: number;
    signatureType: number;
  };
  orderType: OrderType;
  owner: string;
  postOnly?: boolean;
  deferExec?: boolean;
}

export interface OrderResponse {
  success: boolean;
  errorMsg: string;
  orderID: string;
  status: string;
  makingAmount: string;
  takingAmount: string;
  transactionsHashes: string[];
  tradeIDs: string[];
}

export interface Outcome {
  name: string;
  tokenId?: string;
  token_id?: string;
}

export interface Market {
  conditionId?: string;
  slug?: string;
  question?: string;
  clobTokenIds?: string[] | string;
  outcomes?: Outcome[] | string;
}

export interface AppConfig {
  privateKey: string;
  walletAddress: string;
  proxyAddress?: string;
  builderCode?: string;
  credentials?: ClobCredentials;
  marketSlug: string;
  outcome: string;
  orderSize: number;
  maxPosition: number;
  spread: number;
  pollIntervalMs: number;
  gammaUrl: string;
  clobUrl: string;
  dataUrl: string;
  relayerUrl: string;
}
