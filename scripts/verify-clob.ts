import { config } from '../src/config.js';
import { privateKeyToAccount } from 'viem/accounts';
import { ClobClient } from '../src/api/clob.js';
import { getOrCreateClobCredentials } from '../src/auth.js';

console.log('钱包地址:', config.walletAddress);
console.log('私钥已配置:', !!config.privateKey);
console.log('私钥是否占位符:', config.privateKey?.startsWith('0x0000'));
console.log('CLOB URL:', config.clobUrl);

try {
  const signer = privateKeyToAccount(config.privateKey!);
  console.log('签名地址:', signer.address);

  // 尝试派生凭证
  const creds = await getOrCreateClobCredentials(signer, config.clobUrl);
  console.log('凭证获取成功, API Key:', creds.apiKey.substring(0, 8) + '...');

  // 尝试连接 CLOB
  const client = new ClobClient(config.clobUrl, creds, signer.address);
  const orders = await client.getOpenOrders();
  console.log('CLOB 连接成功，当前挂单数:', Array.isArray(orders) ? orders.length : '未知');
} catch (err: any) {
  console.error('错误:', err.message);
  console.error(err.stack?.substring(0, 500));
}
