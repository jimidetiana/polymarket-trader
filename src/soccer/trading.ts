import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { updateWalletBalance, getOrCreateWallet } from './wallet.js';
import { insertOrder, updateOrderStatus, getOrder } from './db.js';
import { getV2Client, getV2Creds } from '../api/clob-v2.js';

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

    // 预扣余额
    if (side === 'BUY') {
      try {
        await updateWalletBalance(walletAddr, -estimatedCost, 'trade_pnl', `买入 ${size} @ ${price.toFixed(2)}`, dbOrderId);
      } catch {
        // ignore
      }
    }

    return {
      success: true,
      orderId: dbOrderId,
      clobOrderId: data.orderID,
      message: `下单成功：${side} ${size} @ ${price.toFixed(2)}`,
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

    await client.cancelOrder(clobOrderId);
    await updateOrderStatus(dbOrderId, 'cancelled', '已取消');

    // 退款
    if (order.side === 'BUY' && order.order_status === 'open') {
      const refundAmount = order.size * order.price;
      try {
        await updateWalletBalance(walletAddr, refundAmount, 'trade_pnl', `取消订单退款 #${dbOrderId}`, dbOrderId);
      } catch {
        // ignore
      }
    }

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
    // ClobClient 没有直接的 cancelAll 方法，先获取所有订单再逐个取消
    const orders = await client.getOpenOrders();
    const orderList = Array.isArray(orders) ? orders : [];
    for (const order of orderList as Array<{ orderID?: string }>) {
      if (order.orderID) {
        await client.cancelOrder(order.orderID);
      }
    }
    return { success: true, message: `已取消 ${orderList.length} 个订单`, count: orderList.length };
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || err.message || '取消失败';
    return { success: false, message: errorMsg, count: 0 };
  }
}

export async function getOpenOrders(): Promise<unknown[]> {
  if (isSimulated()) {
    return [];
  }

  try {
    const client = await getClobClient();
    const orders = await client.getOpenOrders();
    return Array.isArray(orders) ? orders : [];
  } catch {
    return [];
  }
}
