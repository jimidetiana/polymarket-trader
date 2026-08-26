import { privateKeyToAccount } from 'viem/accounts';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';
import { updateWalletBalance, getOrCreateWallet, syncOnChainBalance } from './wallet.js';
import { insertOrder, updateOrderStatus, getOrder } from './db.js';
import { pool } from './db.js';
import { getV2Client, getV2Creds } from '../api/clob-v2.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const gammaProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

async function gammaGetMarket(marketId: string): Promise<any> {
  const MAX_RETRIES = 3;
  let lastErr: any;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const agent = gammaProxyUrl ? new HttpsProxyAgent(gammaProxyUrl, { keepAlive: false }) : undefined;
      const response = await axios.get(`${GAMMA_BASE}/markets/${marketId}`, {
        timeout: 15000,
        ...(agent ? { httpsAgent: agent } : {}),
      });
      return response.data;
    } catch (err: any) {
      lastErr = err;
      const msg = err.message || '';
      if (/aborted|reset|timeout|econnreset|etimedout/i.test(msg) && i < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
    }
  }
  throw lastErr;
}

let signer: ReturnType<typeof privateKeyToAccount> | null = null;

function getSigner() {
  if (!signer) {
    if (!config.privateKey) {
      throw new Error('未配置钱包私钥 (POLYMARKET_PRIVATE_KEY)');
    }
    signer = privateKeyToAccount(config.privateKey);
  }
  return signer;
}

async function getClobClient() {
  return getV2Client();
}

// 钱包地址（用户配置的 WALLET_ADDRESS），用于显示和余额追踪
// 代理地址仅用于订单 maker 字段（orderBuilder 已处理）
function getFundingAddress(): string {
  return config.walletAddress || getSigner().address;
}

function isSimulated(): boolean {
  return !config.privateKey || config.privateKey.startsWith('0x0000');
}

// V2 客户端自动从 API 解析 tickSize 和 negRisk，无需手动传入

export interface PlaceOrderParams {
  market_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  type?: 'limit' | 'market';
}

export interface PlaceOrderResult {
  success: boolean;
  orderId?: number;
  clobOrderId?: string;
  message: string;
  simulated?: boolean;
  finalStatus?: string;
}

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const { market_id, token_id, side, size, price, type = 'limit' } = params;

  if (size <= 0 || price <= 0 || price >= 1) {
    return { success: false, message: '无效的数量或价格' };
  }

  const walletAddr = getFundingAddress();

  // 确保钱包存在
  await getOrCreateWallet(walletAddr);

  // 计算预估成本
  const estimatedCost = side === 'BUY' ? size * price : 0;

  // 模拟模式（无真实私钥）
  if (isSimulated()) {
    const dbOrderId = await insertOrder({
      market_id,
      token_id,
      side,
      size,
      price,
      order_status: 'simulated',
      memo: '模拟下单（未配置真实私钥）',
    });

    // 模拟扣减余额
    if (side === 'BUY') {
      try {
        await updateWalletBalance(walletAddr, -estimatedCost, 'trade_pnl', `模拟买入 ${size} @ ${price}`, dbOrderId);
      } catch {
        // ignore
      }
    }

    return {
      success: true,
      orderId: dbOrderId,
      message: `[模拟] 下单成功：${side} ${size} @ ${price.toFixed(2)}`,
      simulated: true,
    };
  }

  // 真实下单 - 使用 V2 CLOB 客户端 (POLY_1271 deposit wallet)
  try {
    const client = await getClobClient();
    await getV2Creds();

    let response: any;
    if (type === 'market') {
      // 市价单: BUY 用 USDC 金额, SELL 用份额数
      const marketOrderArgs = {
        tokenID: token_id,
        price,
        amount: side === 'BUY' ? size * price : size,
        side: side === 'BUY' ? 'BUY' : 'SELL' as any,
      };
      response = await client.createAndPostMarketOrder(marketOrderArgs);
    } else {
      // 限价单: 使用 size (份额数)
      const limitOrderArgs = {
        tokenID: token_id,
        price,
        size,
        side: side === 'BUY' ? 'BUY' : 'SELL' as any,
      };
      response = await client.createAndPostOrder(limitOrderArgs, {}, 'GTC');
    }

    const data = response as { orderID?: string; success?: boolean; error?: string };

    if (data.error) {
      const dbOrderId = await insertOrder({
        market_id,
        token_id,
        side,
        size,
        price,
        order_status: 'failed',
        memo: `下单失败：${data.error}`,
      });
      return { success: false, orderId: dbOrderId, message: data.error };
    }

    const dbOrderId = await insertOrder({
      market_id,
      token_id,
      side,
      size,
      price,
      order_status: 'open',
      memo: data.orderID ? `订单ID: ${data.orderID}` : '已提交',
    });

    // 下单后即时查询真实状态（不阻塞返回，后台同步会兜底）
    let finalStatus = 'open';
    if (data.orderID) {
      try {
        const orderInfo = await client.getOrder(data.orderID);
        const matched = Number(orderInfo?.size_matched || 0);
        const original = Number(orderInfo?.original_size || size);
        const clobStatus = String(orderInfo?.status || '');

        if (clobStatus === 'CANCELED' || clobStatus === 'CANCELLED') {
          finalStatus = matched > 0 ? 'partial_cancelled' : 'cancelled';
        } else if (matched >= original && original > 0) {
          finalStatus = 'filled';
        } else if (matched > 0) {
          finalStatus = 'partial';
        }

        if (finalStatus !== 'open') {
          await updateOrderStatus(dbOrderId, finalStatus, `下单即时同步: ${clobStatus}`);
          if (finalStatus === 'filled' && side === 'SELL') {
            const sellIncome = size * price;
            try { await updateWalletBalance(walletAddr, sellIncome, 'trade_pnl', `卖出成交 #${dbOrderId}`, dbOrderId); } catch {}
          }
        }
      } catch (e: any) {
        // 即时查询失败不影响下单流程，后台定期同步会兜底
        console.log('[Order] 下单后即时查询失败，等待后台同步:', e.message || e);
      }
    }

    // 交易后自动刷新链上余额
    try { await syncOnChainBalance(walletAddr); } catch {}

    const statusLabel = finalStatus === 'filled' ? '已成交' : finalStatus === 'partial' ? '部分成交' : finalStatus === 'cancelled' ? '已取消' : '挂单中';
    return {
      success: true,
      orderId: dbOrderId,
      clobOrderId: data.orderID,
      message: `下单成功：${side} ${size} @ ${price.toFixed(2)} (${statusLabel})`,
      finalStatus,
    };
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || err.message || '下单失败';
    const dbOrderId = await insertOrder({
      market_id,
      token_id,
      side,
      size,
      price,
      order_status: 'failed',
      memo: `下单失败：${errorMsg}`,
    });
    return { success: false, orderId: dbOrderId, message: errorMsg };
  }
}

export async function cancelOrder(dbOrderId: number): Promise<{ success: boolean; message: string }> {
  const order = await getOrder(dbOrderId);
  if (!order) {
    return { success: false, message: '订单不存在' };
  }

  const walletAddr = getFundingAddress();

  // 模拟模式
  if (isSimulated()) {
    if (order.side === 'BUY' && order.order_status === 'simulated') {
      const refundAmount = order.size * order.price;
      try {
        await updateWalletBalance(walletAddr, refundAmount, 'trade_pnl', `取消订单退款 #${dbOrderId}`, dbOrderId);
      } catch {
        // ignore
      }
    }
    await updateOrderStatus(dbOrderId, 'cancelled', '模拟取消');
    return { success: true, message: '订单已取消（模拟）' };
  }

  // 真实取消 - 使用 V2 CLOB 客户端
  try {
    const client = await getClobClient();
    await getV2Creds();
    // 从 memo 中提取 CLOB 订单ID
    const memoMatch = order.memo?.match(/订单ID:\s*(\S+)/);
    const clobOrderId = memoMatch ? memoMatch[1] : dbOrderId.toString();

    // V2 客户端 cancelOrder 需要对象参数 { orderID: string }
    await client.cancelOrder({ orderID: clobOrderId });
    await updateOrderStatus(dbOrderId, 'cancelled', '已取消');

    // 交易后自动刷新链上余额
    try { await syncOnChainBalance(walletAddr); } catch {}

    return { success: true, message: '订单已取消' };
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || err.message || '取消失败';
    return { success: false, message: errorMsg };
  }
}

export async function cancelAllOrders(): Promise<{ success: boolean; message: string; count: number }> {
  if (isSimulated()) {
    return { success: true, message: '模拟模式，无需取消', count: 0 };
  }

  try {
    const client = await getClobClient();
    await getV2Creds();
    // V2 客户端有 cancelAll 方法，直接调用
    await client.cancelAll();

    // 更新本地所有 open 订单为 cancelled
    await pool.execute(
      `UPDATE soccer_orders SET order_status = 'cancelled', memo = CONCAT(IFNULL(memo, ''), ' | 批量取消') WHERE order_status IN ('open', 'pending')`,
    );

    // 交易后自动刷新链上余额
    const walletAddr = getFundingAddress();
    try { await syncOnChainBalance(walletAddr); } catch {}

    return { success: true, message: '所有挂单已取消', count: 0 };
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || err.message || '取消失败';

    // 如果 cancelAll 失败，回退到逐个取消
    try {
      const client = await getClobClient();
      const orders = await client.getOpenOrders();
      const orderList = Array.isArray(orders) ? orders : [];
      let count = 0;
      for (const order of orderList as Array<{ id?: string; orderID?: string }>) {
        const oid = order.orderID || order.id;
        if (oid) {
          await client.cancelOrder({ orderID: oid });
          count++;
        }
      }
      await pool.execute(
        `UPDATE soccer_orders SET order_status = 'cancelled', memo = CONCAT(IFNULL(memo, ''), ' | 批量取消') WHERE order_status IN ('open', 'pending')`,
      );
      const walletAddr = getFundingAddress();
      try { await syncOnChainBalance(walletAddr); } catch {}
      return { success: true, message: `已取消 ${count} 个挂单`, count };
    } catch (err2: any) {
      return { success: false, message: errorMsg, count: 0 };
    }
  }
}

export async function getOpenOrders(): Promise<unknown[]> {
  if (isSimulated()) {
    return [];
  }

  try {
    const client = await getClobClient();
    await getV2Creds();
    const orders = await client.getOpenOrders();
    return Array.isArray(orders) ? orders : [];
  } catch {
    return [];
  }
}

/**
 * 从 Polymarket 平台同步订单状态并导入链上缺失的订单
 *
 * 逻辑：
 * 1. 获取本地所有订单
 * 2. 从 CLOB 获取当前打开的订单和成交记录
 * 3. 导入链上存在但本地没有的订单（挂单 + 成交）
 * 4. 对已有本地订单，对比更新状态
 */
export async function syncOrderStatus(): Promise<{
  success: boolean;
  message: string;
  total: number;
  matched: number;
  updated: number;
  imported: number;
  details: Array<{ id: number; clobOrderId: string | null; oldStatus: string; newStatus: string; clobStatus?: string; sizeMatched?: string }>;
}> {
  if (isSimulated()) {
    return {
      success: false,
      message: '模拟模式，无法同步',
      total: 0, matched: 0, updated: 0, imported: 0,
      details: [],
    };
  }

  try {
    const client = await getClobClient();
    await getV2Creds();

    // 1. 获取本地所有订单
    const [localOrders] = await pool.execute<any[]>(
      `SELECT id, market_id, token_id, side, size, price, order_status, memo
       FROM soccer_orders
       ORDER BY created_at DESC`,
    );

    // 本地已有的 CLOB 订单 ID 集合（从 memo 提取）
    const localClobIds = new Set<string>();
    for (const o of localOrders) {
      const m = o.memo?.match(/订单ID:\s*(\S+)/);
      if (m) localClobIds.add(m[1]);
    }

    // 2. 构建 token_id → market_id 映射（用于导入链上订单时查找所属市场）
    const [markets] = await pool.execute<any[]>(
      `SELECT id, clob_token_ids FROM soccer_markets WHERE clob_token_ids IS NOT NULL`,
    );
    const tokenToMarket = new Map<string, string>();
    for (const m of markets) {
      let tokenIds: string[] = [];
      try {
        const parsed = typeof m.clob_token_ids === 'string' ? JSON.parse(m.clob_token_ids) : m.clob_token_ids;
        if (Array.isArray(parsed)) tokenIds = parsed.filter(Boolean).map(String);
      } catch {
        tokenIds = String(m.clob_token_ids || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      for (const tid of tokenIds) tokenToMarket.set(tid, String(m.id));
    }

    // 3. 获取 CLOB 平台当前打开的订单
    let openOrderMap = new Map<string, any>();
    let clobOpenOrders: any[] = [];
    try {
      clobOpenOrders = await client.getOpenOrders();
      for (const o of (Array.isArray(clobOpenOrders) ? clobOpenOrders : [])) {
        const oid = (o as any).id || (o as any).orderID || '';
        if (oid) openOrderMap.set(oid, o);
      }
    } catch (e: any) {
      console.log('[Sync] 获取平台挂单失败:', e.message || e);
    }

    // 4. 获取成交记录（分页获取，最多10页）
    const allTrades: any[] = [];
    try {
      let nextCursor: string | undefined = undefined;
      for (let i = 0; i < 10; i++) {
        let resp: any;
        if (nextCursor) {
          resp = await client.getTradesPaginated({}, nextCursor);
        } else {
          resp = await client.getTradesPaginated();
        }
        const trades = resp?.trades || (Array.isArray(resp) ? resp : []);
        if (trades.length) allTrades.push(...trades);
        nextCursor = resp?.next_cursor || undefined;
        if (!nextCursor || nextCursor === 'LTE=' || nextCursor === '-1') break;
      }
    } catch (e: any) {
      console.log('[Sync] 获取成交记录失败:', e.message || e);
    }

    const clobApiAvailable = openOrderMap.size > 0 || allTrades.length > 0;
    let importedCount = 0;

    // 5. 导入链上存在但本地没有的挂单
    for (const clobOrder of clobOpenOrders) {
      const oid = (clobOrder as any).id || (clobOrder as any).orderID || '';
      if (!oid || localClobIds.has(oid)) continue;

      const tokenId = String((clobOrder as any).asset_id || '');
      const marketId = tokenToMarket.get(tokenId);
      if (!marketId) continue; // 不属于足球赛事的订单跳过

      const side = (clobOrder as any).side === 'BUY' ? 'BUY' : 'SELL';
      const size = Number((clobOrder as any).original_size || 0);
      const price = Number((clobOrder as any).price || 0);
      if (!size || !price) continue;

      const dbId = await insertOrder({
        market_id: marketId,
        token_id: tokenId,
        side: side as 'BUY' | 'SELL',
        size,
        price,
        order_status: 'open',
        memo: `链上同步 订单ID: ${oid}`,
      });
      localClobIds.add(oid);
      localOrders.push({
        id: dbId, market_id: marketId, token_id: tokenId,
        side, size, price, order_status: 'open',
        memo: `链上同步 订单ID: ${oid}`,
      });
      importedCount++;
      console.log(`[Sync] 导入挂单 #${dbId}: ${side} ${size} @ ${price} (CLOB: ${oid})`);
    }

    // 6. 导入链上成交记录（按 taker_order_id 分组）
    const tradesByOrderId = new Map<string, any[]>();
    const tradesByKey = new Map<string, any[]>();
    for (const t of allTrades) {
      const oid = t.taker_order_id || '';
      if (oid) {
        if (!tradesByOrderId.has(oid)) tradesByOrderId.set(oid, []);
        tradesByOrderId.get(oid)!.push(t);
      }
      const key = `${t.asset_id}_${(t.side || '').toUpperCase()}_${Number(t.price).toFixed(4)}`;
      if (!tradesByKey.has(key)) tradesByKey.set(key, []);
      tradesByKey.get(key)!.push(t);
    }

    for (const [oid, trades] of tradesByOrderId) {
      if (!oid || localClobIds.has(oid)) continue;

      const first = trades[0];
      const tokenId = String(first.asset_id || '');
      const marketId = tokenToMarket.get(tokenId);
      if (!marketId) continue;

      const side = (first.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
      const totalSize = trades.reduce((sum, t) => sum + Number(t.size || 0), 0);
      const price = Number(first.price || 0);
      if (!totalSize || !price) continue;

      const dbId = await insertOrder({
        market_id: marketId,
        token_id: tokenId,
        side: side as 'BUY' | 'SELL',
        size: totalSize,
        price,
        order_status: 'filled',
        memo: `链上同步 订单ID: ${oid}`,
      });
      localClobIds.add(oid);
      localOrders.push({
        id: dbId, market_id: marketId, token_id: tokenId,
        side, size: totalSize, price, order_status: 'filled',
        memo: `链上同步 订单ID: ${oid}`,
      });
      importedCount++;
      console.log(`[Sync] 导入成交 #${dbId}: ${side} ${totalSize} @ ${price} (CLOB: ${oid})`);
    }

    // 如果本地无订单且链上也没有数据
    if (!localOrders.length) {
      return {
        success: true,
        message: '没有订单需要同步',
        total: 0, matched: 0, updated: 0, imported: 0,
        details: [],
      };
    }

    // 7. 对已有本地订单，对比更新状态
    const details: Array<{ id: number; clobOrderId: string | null; oldStatus: string; newStatus: string; clobStatus?: string; sizeMatched?: string }> = [];
    let matchedCount = 0;
    let updatedCount = 0;
    const walletAddr = getFundingAddress();

    for (const localOrder of localOrders) {
      const memoMatch = localOrder.memo?.match(/订单ID:\s*(\S+)/);
      const clobOrderId = memoMatch ? memoMatch[1] : null;

      let clobStatus: string | undefined;
      let newStatus: string = localOrder.order_status;
      let sizeMatched: string | undefined;

      if (!clobApiAvailable) {
        matchedCount++;
        continue;
      }

      // 终态订单不被覆盖：已结算(settled)和下单失败(failed)不参与同步
      // failed 订单从未上链，无 CLOB ID，按 token_id 匹配会误判为其他订单的成交
      if (localOrder.order_status === 'settled' || localOrder.order_status === 'failed') {
        matchedCount++;
        continue;
      }

      if (clobOrderId) {
        if (openOrderMap.has(clobOrderId)) {
          const clobOrder = openOrderMap.get(clobOrderId);
          clobStatus = clobOrder?.status || 'LIVE';
          sizeMatched = clobOrder?.size_matched || '0';
          const matched = Number(sizeMatched);
          const original = Number(clobOrder?.original_size || localOrder.size);

          if (matched >= original && original > 0) {
            newStatus = 'filled';
          } else if (matched > 0) {
            newStatus = 'partial';
          } else {
            newStatus = 'open';
          }
        } else {
          // 不在 open 列表：先查 trades（成交记录最可靠），再查 getOrder
          const trades = tradesByOrderId.get(clobOrderId);
          if (trades && trades.length > 0) {
            // 有成交记录 → 根据成交量判断状态
            const totalMatched = trades.reduce((sum, t) => sum + Number(t.size || 0), 0);
            sizeMatched = String(totalMatched);
            newStatus = totalMatched >= Number(localOrder.size) ? 'filled' : 'partial';
          } else {
            // 无成交记录，尝试 getOrder 查询精确状态
            try {
              const orderInfo = await client.getOrder(clobOrderId);
              clobStatus = orderInfo?.status || '';
              sizeMatched = orderInfo?.size_matched || '0';
              const matched = Number(sizeMatched);
              const original = Number(orderInfo?.original_size || localOrder.size);

              if (clobStatus === 'CANCELED' || clobStatus === 'CANCELLED') {
                newStatus = matched > 0 ? 'partial_cancelled' : 'cancelled';
              } else if (matched >= original && original > 0) {
                newStatus = 'filled';
              } else if (matched > 0) {
                newStatus = 'partial';
              } else {
                newStatus = localOrder.order_status;
              }
            } catch {
              // getOrder 失败 → 不确定状态，保留当前状态
              newStatus = localOrder.order_status;
            }
          }
        }
      } else {
        // 无 CLOB 订单 ID，用 token_id + side + price 匹配 trades
        const tradeKey = `${localOrder.token_id}_${localOrder.side}_${Number(localOrder.price).toFixed(4)}`;
        const matchedTrades = tradesByKey.get(tradeKey);

        if (matchedTrades && matchedTrades.length > 0) {
          const totalMatched = matchedTrades.reduce((sum, t) => sum + Number(t.size || 0), 0);
          sizeMatched = String(totalMatched);
          newStatus = totalMatched >= Number(localOrder.size) ? 'filled' : 'partial';
        } else {
          // 无匹配成交，保留当前状态
          newStatus = localOrder.order_status;
        }
      }

      matchedCount++;

      if (newStatus !== localOrder.order_status) {
        await updateOrderStatus(localOrder.id, newStatus, `平台同步: ${clobStatus || 'N/A'}`);

        if (newStatus === 'filled' && localOrder.side === 'SELL') {
          const sellIncome = Number(localOrder.size) * Number(localOrder.price);
          try { await updateWalletBalance(walletAddr, sellIncome, 'trade_pnl', `卖出成交 #${localOrder.id}`, localOrder.id); } catch {}
        } else if (newStatus === 'cancelled' && localOrder.side === 'BUY' &&
                   (localOrder.order_status === 'open' || localOrder.order_status === 'pending')) {
          const refundAmount = Number(localOrder.size) * Number(localOrder.price);
          try { await updateWalletBalance(walletAddr, refundAmount, 'trade_pnl', `同步退款 #${localOrder.id}`, localOrder.id); } catch {}
        }

        updatedCount++;
        details.push({ id: localOrder.id, clobOrderId, oldStatus: localOrder.order_status, newStatus, clobStatus, sizeMatched });
      }
    }

    const apiNote = clobApiAvailable ? '' : ' (CLOB API 不可用，仅本地数据)';
    const importNote = importedCount > 0 ? `, 导入 ${importedCount} 笔链上订单` : '';
    return {
      success: true,
      message: `同步完成: 共 ${matchedCount} 个订单, ${updatedCount} 个状态已更新${importNote}${apiNote}`,
      total: matchedCount,
      matched: matchedCount,
      updated: updatedCount,
      imported: importedCount,
      details,
    };
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || err.message || '同步失败';
    return {
      success: false,
      message: errorMsg,
      total: 0, matched: 0, updated: 0, imported: 0,
      details: [],
    };
  }
}

/**
 * 同步市场结算信息
 *
 * 当 Polymarket 市场结算（resolve）后，持仓需要标记为已结算。
 * 查询 gamma API 确认市场是否已关闭，获取最终结果价格。
 * 赢方持仓价值 = net_size × $1，输方 = $0。
 */
export async function syncSettlements(): Promise<{
  success: boolean;
  message: string;
  settledCount: number;
  details: any[];
}> {
  try {
    // 获取所有已成交但未结算的持仓（按 token_id 分组）
    const [positions] = await pool.execute<any[]>(
      `SELECT token_id, MAX(market_id) as market_id,
              SUM(CASE WHEN side = 'BUY' THEN size ELSE -size END) as net_size
       FROM soccer_orders
       WHERE order_status IN ('filled', 'partial', 'partial_cancelled')
       GROUP BY token_id
       HAVING net_size > 0`,
    );

    if (!positions.length) {
      return { success: true, message: '无持仓需要结算', settledCount: 0, details: [] };
    }

    // 获取已结算的 token_id，避免重复处理
    const [settled] = await pool.execute<any[]>(
      `SELECT DISTINCT token_id FROM soccer_orders WHERE order_status = 'settled'`,
    );
    const settledTokens = new Set(settled.map(r => String(r.token_id)));

    // 过滤掉已结算的
    const pending = positions.filter(p => !settledTokens.has(String(p.token_id)));
    if (!pending.length) {
      return { success: true, message: '所有持仓已结算', settledCount: 0, details: [] };
    }

    // 获取本地市场的 clob_token_ids（用于匹配 token_id 到 outcome 索引）
    const marketIds = [...new Set(pending.map(p => String(p.market_id)))];
    const [markets] = await pool.execute<any[]>(
      `SELECT id, clob_token_ids, outcomes FROM soccer_markets WHERE id IN (${marketIds.map(() => '?').join(',')})`,
      marketIds,
    );
    const marketMap = new Map<string, { clobTokenIds: string[]; outcomes: string[] }>();
    for (const m of markets) {
      let tokenIds: string[] = [];
      let outcomes: string[] = [];
      try {
        const p = typeof m.clob_token_ids === 'string' ? JSON.parse(m.clob_token_ids) : m.clob_token_ids;
        if (Array.isArray(p)) tokenIds = p.filter(Boolean).map(String);
      } catch {
        tokenIds = String(m.clob_token_ids || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      try {
        const o = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        if (Array.isArray(o)) outcomes = o.filter(Boolean).map(String);
      } catch {
        outcomes = String(m.outcomes || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      marketMap.set(String(m.id), { clobTokenIds: tokenIds, outcomes });
    }

    // 查询 gamma API 确认市场是否已结算
    const resolutionMap = new Map<string, { closed: boolean; outcomePrices: number[] }>();
    for (const mid of marketIds) {
      try {
        const m = await gammaGetMarket(mid);
        if (!m) continue;
        const closed = m.closed === true;
        let prices: number[] = [];
        try {
          const raw = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(raw)) prices = raw.map((p: any) => Number(p));
        } catch {}
        resolutionMap.set(mid, { closed, outcomePrices: prices });
      } catch (err: any) {
        console.log(`[Settlement] 查询市场 ${mid} 失败:`, err.message || err);
      }
    }

    const walletAddr = getFundingAddress();
    const details: any[] = [];
    let settledCount = 0;

    for (const pos of pending) {
      const mid = String(pos.market_id);
      const resolution = resolutionMap.get(mid);
      if (!resolution || !resolution.closed) continue;

      const localMarket = marketMap.get(mid);
      if (!localMarket) continue;

      const tokenId = String(pos.token_id);
      const tokenIdx = localMarket.clobTokenIds.findIndex(t => t === tokenId);
      if (tokenIdx < 0) continue;

      // 结算价格：1 = 赢，0 = 输
      const finalPrice = resolution.outcomePrices[tokenIdx];
      if (finalPrice === undefined) continue;

      const won = finalPrice >= 0.5;
      const netSize = Number(pos.net_size);
      const settlementValue = won ? netSize : 0;

      // 更新所有该 token 的已成交订单状态为 settled
      await pool.execute(
        `UPDATE soccer_orders SET order_status = 'settled',
         memo = CONCAT(IFNULL(memo, ''), ' | 结算: ${won ? '赢' : '输'} $${settlementValue.toFixed(2)}')
         WHERE token_id = ? AND order_status IN ('filled', 'partial', 'partial_cancelled')`,
        [tokenId],
      );

      // 记录结算收入到钱包
      if (settlementValue > 0) {
        try {
          await updateWalletBalance(walletAddr, settlementValue, 'trade_pnl', `市场结算 ${won ? '赢' : '输'} #${mid}`, null);
        } catch {}
      }

      settledCount++;
      details.push({ tokenId, marketId: mid, netSize, won, settlementValue, finalPrice });

      // 刷新链上余额
      try { await syncOnChainBalance(walletAddr); } catch {}
    }

    return {
      success: true,
      message: settledCount > 0 ? `结算同步完成: ${settledCount} 个持仓已结算` : '无已结算的市场',
      settledCount,
      details,
    };
  } catch (err: any) {
    const errorMsg = err.message || '结算同步失败';
    return { success: false, message: errorMsg, settledCount: 0, details: [] };
  }
}
