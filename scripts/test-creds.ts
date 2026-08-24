import { config } from '../src/config.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createL1Signature } from '../src/auth.js';
import { createHttpClient } from '../src/proxy.js';

async function main() {
  const signer = privateKeyToAccount(config.privateKey);
  const http = createHttpClient({ baseURL: config.clobUrl, timeout: 15000 });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '0';
  const signature = await createL1Signature(signer, timestamp, nonce);

  const headers = {
    POLY_ADDRESS: signer.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce,
  };

  console.log('Signer:', signer.address);
  console.log('Timestamp:', timestamp);

  // Try derive
  try {
    const derive = await http.get('/auth/derive-api-key', { headers });
    console.log('\n✅ Derive success:');
    console.log('  apiKey:', derive.data.apiKey);
    console.log('  secret:', derive.data.secret);
    console.log('  passphrase:', derive.data.passphrase);
  } catch (err: any) {
    console.log('\n❌ Derive failed:', err.response?.status, JSON.stringify(err.response?.data).slice(0, 200));
  }

  // Try create fresh
  try {
    const create = await http.post('/auth/api-key', {}, { headers });
    console.log('\n✅ Create success:');
    console.log('  apiKey:', create.data.apiKey);
    console.log('  secret:', create.data.secret);
    console.log('  passphrase:', create.data.passphrase);
  } catch (err: any) {
    console.log('\n❌ Create failed:', err.response?.status, JSON.stringify(err.response?.data).slice(0, 200));
  }
}

main().catch(console.error);
