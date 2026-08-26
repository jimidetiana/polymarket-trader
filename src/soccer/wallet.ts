import mysql from 'mysql2/promise';
import { pool } from './db.js';
import { createHttpClient } from '../proxy.js';
import { config } from '../config.js';
import { ClobClient } from '../api/clob.js';
import { getOrCreateClobCredentials } from '../auth.js';
import { getPublicProfile, getUserValue, type PublicProfile } from '../gamma.js';
import { privateKeyToAccount } from 'viem/accounts';
import { getV2Balance } from '../api/clob-v2.js';

// HTTP client that goes through proxy if configured
const httpClient = createHttpClient({ timeout: 5000 });

// Profile cache (valid for 5 minutes)
let cachedProfile: PublicProfile | null = null;
let profileCacheTime = 0;
const PROFILE_CACHE_TTL = 5 * 60 * 1000;

// CLOB credentials cache
let cachedCreds: any = null;
let cachedSignerAddr = '';

// BNB chain token configs
const BSC_TOKENS = [
  { contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
  { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT' },
];

const POLYGON_TOKENS = [
  { contract: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', decimals: 6, symbol: 'USDC.e' },
  { contract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, symbol: 'USDC' },
];

interface BalanceResult {
  chain: string;
  symbol: string;
  balance: number;
  success: boolean;
}

function encodeBalanceOf(address: string): string {
  const cleanAddr = address.toLowerCase().replace(/^0x/, '');
  const padded = cleanAddr.padStart(64, '0');
  return '0x70a08231' + padded;
}

async function queryTokenBalance(chain: string, rpcUrl: string, tokens: typeof BSC_TOKENS, address: string): Promise<BalanceResult[]> {
  const results: BalanceResult[] = [];
  for (const token of tokens) {
    try {
      const resp = await httpClient.post(rpcUrl, {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: token.contract, data: encodeBalanceOf(address) }, 'latest'],
        id: 1,
      });
      const result = resp.data?.result as string | undefined;
      if (result && result !== '0x' && result !== '0x0') {
        const balance = Number(BigInt(result)) / Math.pow(10, token.decimals);
        results.push({ chain, symbol: token.symbol, balance, success: true });
      } else {
        results.push({ chain, symbol: token.symbol, balance: 0, success: true });
      }
    } catch {
      results.push({ chain, symbol: token.symbol, balance: 0, success: false });
    }
  }
  return results;
}

async function queryNativeBalance(chain: string, rpcUrl: string, address: string): Promise<BalanceResult> {
  try {
    const resp = await httpClient.post(rpcUrl, {
      jsonrpc: '2.0',
      method: 'eth_getBalance',
      params: [address, 'latest'],
      id: 1,
    });
    const result = resp.data?.result as string | undefined;
    const symbol = chain === 'bsc' ? 'BNB' : 'MATIC';
    if (result && result !== '0x' && result !== '0x0') {
      const balance = Number(BigInt(result)) / Math.pow(10, 18);
      return { chain, symbol, balance, success: true };
    }
    return { chain, symbol, balance: 0, success: true };
  } catch {
    const symbol = chain === 'bsc' ? 'BNB' : 'MATIC';
    return { chain, symbol, balance: 0, success: false };
  }
}

// Query Polymarket internal balance via V2 CLOB API (POLY_1271 deposit wallet)
// 返回 null 表示查询失败，返回数字（含0）表示查询成功
async function getPolymarketSignerBalance(): Promise<number | null> {
  try {
    if (!config.privateKey) return null;
    const result = await getV2Balance();
    const balance = Number(result?.balance || 0);
    console.log('[Polymarket V2] deposit wallet 余额:', balance, '(raw pUSD)');
    return balance;
  } catch (err: any) {
    console.warn('[Polymarket V2] 余额查询失败:', err.response?.data?.error || err.message?.slice(0, 100));
    return null;
  }
}

// Get Polymarket public profile for the signer address (cached)
export async function getPolymarketProfile(): Promise<PublicProfile | null> {
  const now = Date.now();
  if (cachedProfile && now - profileCacheTime < PROFILE_CACHE_TTL) {
    return cachedProfile;
  }
  try {
    if (!config.privateKey) return null;
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    const profile = await getPublicProfile(account.address);
    if (profile) {
      console.log('[Polymarket Profile] 用户名:', profile.name, '代理钱包:', profile.proxyWallet);
      cachedProfile = profile;
      profileCacheTime = now;
    }
    return profile;
  } catch (err: any) {
    console.warn('[Polymarket Profile] 查询失败:', err.message?.slice(0, 100));
    return cachedProfile; // Return stale cache on error
  }
}

// Get total portfolio value from data API (works without auth)
export async function getPolymarketPortfolioValue(userAddress: string): Promise<number> {
  try {
    return await getUserValue(userAddress);
  } catch {
    return 0;
  }
}

export async function getAllBalances(address: string): Promise<BalanceResult[]> {
  const addressesToCheck = [address];
  if (config.proxyAddress && config.proxyAddress !== address) {
    addressesToCheck.push(config.proxyAddress);
  }

  const results: BalanceResult[] = [];

  // Query all chain balances in parallel for faster response
  const chainPromises: Promise<BalanceResult[]>[] = [];
  for (const addr of addressesToCheck) {
    chainPromises.push(Promise.all([
      queryNativeBalance('bsc', 'https://bsc-rpc.publicnode.com', addr),
      queryTokenBalance('bsc', 'https://bsc-rpc.publicnode.com', BSC_TOKENS, addr),
      queryNativeBalance('polygon', 'https://polygon-bor-rpc.publicnode.com', addr),
      queryTokenBalance('polygon', 'https://polygon-bor-rpc.publicnode.com', POLYGON_TOKENS, addr),
    ]).then(([nativeBsc, tokensBsc, nativePoly, tokensPoly]) => [
      nativeBsc,
      ...tokensBsc,
      nativePoly,
      ...tokensPoly,
    ]));
  }

  // Also query Polymarket data in parallel
  const polySignerPromise = getPolymarketSignerBalance().catch(() => null);
  const profilePromise = getPolymarketProfile().catch(() => null);

  const [chainResults, polySignerBalance, profile] = await Promise.all([
    Promise.all(chainPromises),
    polySignerPromise,
    profilePromise,
  ]);

  for (const addrResults of chainResults) {
    results.push(...addrResults);
  }

  // Polymarket internal balance (deposit wallet / POLY_1271)
  if (polySignerBalance !== null) {
    const pUsdBalance = polySignerBalance / 1_000_000;
    results.push({ chain: 'polymarket', symbol: 'pUSD', balance: pUsdBalance, success: true });
  }

  // Polymarket portfolio value (from data API, uses proxy wallet)
  if (profile?.proxyWallet) {
    try {
      const portfolioValue = await getPolymarketPortfolioValue(profile.proxyWallet);
      if (portfolioValue > 0) {
        results.push({ chain: 'polymarket', symbol: 'Portfolio', balance: portfolioValue, success: true });
      }
    } catch {
      // ignore
    }
  }

  return results;
}

export async function getOnChainUsdcBalance(address: string): Promise<number> {
  const balances = await getAllBalances(address);
  console.log('[Balance] 查询结果:');
  for (const b of balances) {
    if (b.balance > 0) {
      console.log(`  ${b.chain} ${b.symbol}: ${b.balance}`);
    }
  }
  const usdcBalances = balances.filter(b =>
    (b.symbol === 'USDC' || b.symbol === 'USDC.e' || b.symbol === 'USDT') && b.balance > 0
  );
  if (usdcBalances.length > 0) {
    return Math.max(...usdcBalances.map(b => b.balance));
  }
  return 0;
}

// ---- Database operations ----

export interface WalletRow {
  id: number;
  wallet_address: string;
  balance_usdc: string;
  total_deposited: string;
  total_withdrawn: string;
  total_pnl: string;
  chain_balance: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WalletTxRow {
  id: number;
  wallet_address: string;
  tx_type: 'deposit' | 'withdraw' | 'trade_pnl' | 'fee' | 'other';
  amount: string;
  balance_after: string | null;
  order_id: number | null;
  tx_hash: string | null;
  description: string | null;
  status: 'pending' | 'completed' | 'failed';
  created_at: string;
}

export async function getWallet(address: string): Promise<WalletRow | null> {
  const [rows] = await pool.execute<WalletRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_wallets WHERE wallet_address = ? LIMIT 1`,
    [address],
  );
  return rows[0] || null;
}

export async function getOrCreateWallet(address: string): Promise<WalletRow> {
  let wallet = await getWallet(address);
  if (!wallet) {
    await pool.execute(
      `INSERT IGNORE INTO soccer_wallets (wallet_address, balance_usdc) VALUES (?, 0)`,
      [address],
    );
    wallet = await getWallet(address);
  }
  return wallet!;
}

export async function updateWalletBalance(
  address: string,
  delta: number,
  txType: 'deposit' | 'withdraw' | 'trade_pnl' | 'fee' | 'other',
  description?: string,
  orderId?: number,
): Promise<{ wallet: WalletRow; txId: number }> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query<WalletRow[] & mysql.RowDataPacket[]>(
      `SELECT * FROM soccer_wallets WHERE wallet_address = ? FOR UPDATE`,
      [address],
    );
    let wallet = rows[0];
    if (!wallet) {
      await conn.execute(
        `INSERT INTO soccer_wallets (wallet_address, balance_usdc) VALUES (?, 0)`,
        [address],
      );
      const [newRows] = await conn.query<WalletRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM soccer_wallets WHERE wallet_address = ? FOR UPDATE`,
        [address],
      );
      wallet = newRows[0];
    }

    const currentBalance = parseFloat(wallet.balance_usdc);
    const newBalance = currentBalance + delta;
    if (newBalance < 0) {
      throw new Error('余额不足');
    }

    const totalDeposited = txType === 'deposit' ? parseFloat(wallet.total_deposited) + delta : parseFloat(wallet.total_deposited);
    const totalWithdrawn = txType === 'withdraw' ? parseFloat(wallet.total_withdrawn) + Math.abs(delta) : parseFloat(wallet.total_withdrawn);
    const totalPnl = txType === 'trade_pnl' ? parseFloat(wallet.total_pnl) + delta : parseFloat(wallet.total_pnl);

    await conn.execute(
      `UPDATE soccer_wallets SET balance_usdc = ?, total_deposited = ?, total_withdrawn = ?, total_pnl = ? WHERE wallet_address = ?`,
      [newBalance, totalDeposited, totalWithdrawn, totalPnl, address],
    );

    const [result] = await conn.execute<mysql.OkPacket>(
      `INSERT INTO soccer_wallet_transactions (wallet_address, tx_type, amount, balance_after, order_id, description, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
      [address, txType, delta, newBalance, orderId || null, description || null],
    );

    await conn.commit();

    const updatedWallet = await getWallet(address);
    return { wallet: updatedWallet!, txId: result.insertId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function deposit(address: string, amount: number, description?: string): Promise<WalletRow> {
  if (amount <= 0) throw new Error('充值金额必须大于 0');
  const { wallet } = await updateWalletBalance(address, amount, 'deposit', description || '手动充值');
  return wallet;
}

export async function withdraw(address: string, amount: number, description?: string): Promise<WalletRow> {
  if (amount <= 0) throw new Error('提现金额必须大于 0');
  const { wallet } = await updateWalletBalance(address, -amount, 'withdraw', description || '手动提现');
  return wallet;
}

export async function syncChainBalance(address: string, chainBalance: number): Promise<void> {
  await pool.execute(
    `UPDATE soccer_wallets SET chain_balance = ?, last_sync_at = NOW() WHERE wallet_address = ?`,
    [chainBalance, address],
  );
}

// Sync on-chain balance to database
// 链上余额是真值，本地 balance_usdc 只是缓存，始终与链上保持一致
export async function syncOnChainBalance(address: string): Promise<{ chainBalance: number; dbBalance: number; details?: BalanceResult[] }> {
  const balances = await getAllBalances(address);

  // 检查是否有任何查询成功
  const anySuccess = balances.some(b => b.success);
  if (!anySuccess) {
    console.warn('[Balance] 所有余额查询失败，跳过数据库更新，保留现有余额');
    const wallet = await getWallet(address);
    const dbBalance = wallet ? parseFloat(wallet.balance_usdc) : 0;
    return { chainBalance: dbBalance, dbBalance, details: balances };
  }

  const pUsd = balances.find(b => b.chain === 'polymarket' && b.symbol === 'pUSD');

  // 用户配置了私钥（使用 Polymarket）但 pUSD 查询失败时，
  // 不能回退到链上 USDC（用户资金在 Polymarket 内部，链上 USDC=0 是正常的）
  if (config.privateKey && !pUsd) {
    console.warn('[Balance] pUSD 查询失败（CLOB API 不可用），跳过数据库更新，保留现有余额');
    const wallet = await getWallet(address);
    const dbBalance = wallet ? parseFloat(wallet.balance_usdc) : 0;
    return { chainBalance: dbBalance, dbBalance, details: balances };
  }

  const usdcBalances = balances.filter(b =>
    (b.symbol === 'USDC' || b.symbol === 'USDC.e' || b.symbol === 'USDT') && b.balance > 0
  );
  const onChainUsdc = usdcBalances.length > 0 ? Math.max(...usdcBalances.map(b => b.balance)) : 0;
  const chainBalance = pUsd ? pUsd.balance : onChainUsdc;

  await pool.execute(
    `UPDATE soccer_wallets SET chain_balance = ?, balance_usdc = ?, last_sync_at = NOW() WHERE wallet_address = ?`,
    [chainBalance, chainBalance, address],
  );

  const wallet = await getWallet(address);
  return {
    chainBalance,
    dbBalance: wallet ? parseFloat(wallet.balance_usdc) : 0,
    details: balances,
  };
}

export async function getWalletTransactions(
  address: string,
  options: { limit?: number; offset?: number; txType?: string } = {},
): Promise<{ list: WalletTxRow[]; total: number }> {
  const { limit = 50, offset = 0, txType } = options;
  const conditions: string[] = ['wallet_address = ?'];
  const params: unknown[] = [address];

  if (txType) {
    conditions.push('tx_type = ?');
    params.push(txType);
  }

  const whereClause = conditions.join(' AND ');

  const [countRows] = await pool.execute<{ total: number }[] & mysql.RowDataPacket[]>(
    `SELECT COUNT(*) as total FROM soccer_wallet_transactions WHERE ${whereClause}`,
    params,
  );

  const [rows] = await pool.execute<WalletTxRow[] & mysql.RowDataPacket[]>(
    `SELECT * FROM soccer_wallet_transactions WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return { list: rows, total: countRows[0]?.total ?? 0 };
}
