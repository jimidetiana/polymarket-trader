import type { Address, Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { OrderType, Side, SignedOrder } from './types.js';
import { config } from './config.js';
import { CHAIN_ID, encodeLimitAmounts, encodeMarketAmounts, exchangeAddress, generateSalt, ZERO_BYTES32 } from './utils.js';

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' },
    { name: 'builder', type: 'bytes32' },
  ],
} as const;

function signatureType(): number {
  if (config.proxyAddress) return 1; // POLY_PROXY
  return 0; // EOA
}

function makerAddress(signer: PrivateKeyAccount): string {
  return config.proxyAddress ?? signer.address;
}

function builder(): Hex {
  return config.builderCode && config.builderCode.length === 66
    ? (config.builderCode as Hex)
    : ZERO_BYTES32;
}

export async function buildLimitOrder(
  signer: PrivateKeyAccount,
  tokenId: string,
  side: Side,
  price: string,
  size: string,
  tickSize: string,
  negRisk: boolean,
  orderType: OrderType = 'GTC',
  expirationSeconds = 0,
  postOnly = false,
): Promise<SignedOrder> {
  const { makerAmount, takerAmount } = encodeLimitAmounts(side, price, size, tickSize);
  const exchange = exchangeAddress(negRisk) as Address;
  const sigType = signatureType();
  const maker = (makerAddress(signer) as Address);
  const signerAddr = signer.address;
  const salt = generateSalt();
  const timestampMs = Date.now();
  const metadata = ZERO_BYTES32 as Hex;
  const builderCode = builder();

  const signature = await signer.signTypedData({
    domain: {
      name: 'Polymarket CTF Exchange',
      version: '2',
      chainId: CHAIN_ID,
      verifyingContract: exchange,
    },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: {
      salt: BigInt(salt),
      maker,
      signer: signerAddr,
      tokenId: BigInt(tokenId),
      makerAmount,
      takerAmount,
      side: side === 'BUY' ? 0 : 1,
      signatureType: sigType,
      timestamp: BigInt(timestampMs),
      metadata,
      builder: builderCode,
    },
  });

  return {
    order: {
      maker,
      signer: signerAddr,
      tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      side,
      expiration: orderType === 'GTD' ? expirationSeconds.toString() : '0',
      timestamp: timestampMs.toString(),
      metadata: ZERO_BYTES32,
      builder: builderCode,
      signature,
      salt,
      signatureType: sigType,
    },
    orderType,
    owner: config.credentials?.apiKey ?? '',
    postOnly,
    deferExec: false,
  };
}

export async function buildMarketOrder(
  signer: PrivateKeyAccount,
  tokenId: string,
  side: Side,
  price: string,
  amount: string, // USD for BUY, shares for SELL
  tickSize: string,
  negRisk: boolean,
  orderType: OrderType = 'FAK',
): Promise<SignedOrder> {
  const { makerAmount, takerAmount } = encodeMarketAmounts(side, price, amount, tickSize);
  const exchange = exchangeAddress(negRisk) as Address;
  const sigType = signatureType();
  const maker = (makerAddress(signer) as Address);
  const signerAddr = signer.address;
  const salt = generateSalt();
  const timestampMs = Date.now();
  const metadata = ZERO_BYTES32 as Hex;
  const builderCode = builder();

  const signature = await signer.signTypedData({
    domain: {
      name: 'Polymarket CTF Exchange',
      version: '2',
      chainId: CHAIN_ID,
      verifyingContract: exchange,
    },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: {
      salt: BigInt(salt),
      maker,
      signer: signerAddr,
      tokenId: BigInt(tokenId),
      makerAmount,
      takerAmount,
      side: side === 'BUY' ? 0 : 1,
      signatureType: sigType,
      timestamp: BigInt(timestampMs),
      metadata,
      builder: builderCode,
    },
  });

  return {
    order: {
      maker,
      signer: signerAddr,
      tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      side,
      expiration: '0',
      timestamp: timestampMs.toString(),
      metadata,
      builder: builderCode,
      signature,
      salt,
      signatureType: sigType,
    },
    orderType,
    owner: config.credentials?.apiKey ?? '',
    deferExec: false,
  };
}
