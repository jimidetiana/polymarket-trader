import crypto from 'node:crypto';

const secret = 'e2180f802e4b4356ebf3ac89c075950a0cfac84bef11aabdf88a9210ab4a1b97';
const timestamp = '1787499300';
const method = 'GET';
const path = '/balance-allowance?asset_type=USDC';

// Test base64 decode
const keyB64 = Buffer.from(secret, 'base64');
console.log('Base64 key length:', keyB64.length, 'bytes');
console.log('Base64 key hex:', keyB64.toString('hex'));

// Test hex decode
const keyHex = Buffer.from(secret, 'hex');
console.log('Hex key length:', keyHex.length, 'bytes');
console.log('Hex key hex:', keyHex.toString('hex'));

// Compute HMAC with base64 key
const message = `${timestamp}${method}${path}`;
const hmacB64 = crypto.createHmac('sha256', keyB64).update(message).digest();
const sigB64 = hmacB64.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
console.log('\nBase64 HMAC signature:', sigB64);

// Compute HMAC with hex key
const hmacHex = crypto.createHmac('sha256', keyHex).update(message).digest();
const sigHex = hmacHex.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
console.log('Hex HMAC signature:', sigHex);
