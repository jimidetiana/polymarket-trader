import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createProxyAgent } from '../proxy.js';
import { sleep } from '../utils.js';

export class ClobMarketWebSocket extends EventEmitter {
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly agent = createProxyAgent();

  constructor(
    private readonly url: string,
    private readonly tokenIds: string[],
    private readonly reconnectMs = 5000,
  ) {
    super();
  }

  connect(): void {
    if (this.closed) return;
    this.ws = new WebSocket(this.url, { agent: this.agent });

    this.ws.on('open', () => {
      this.emit('open');
      const subscribe = {
        type: 'market',
        assets_ids: this.tokenIds,
        initial_dump: true,
        level: 2,
      };
      this.send(subscribe);
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      const text = data.toString();
      if (text === 'PONG') {
        this.emit('pong');
        return;
      }
      try {
        const message = JSON.parse(text);
        this.emit(message.event_type ?? 'message', message);
      } catch {
        this.emit('raw', text);
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      this.emit('close');
      if (!this.closed) {
        sleep(this.reconnectMs).then(() => this.connect());
      }
    });
  }

  private send(payload: unknown): void {
    this.ws?.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.ws?.send('PING');
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }
}
