import { DEFAULTS, WS_PATH } from '@track/contract';
import type {
  ActivitySample,
  ClientMessage,
  GroupColor,
  GroupRenameMessage,
  HelloMessage,
  PingMessage,
  SampleMessage,
  ServerMessage,
} from '@track/contract';
import { getWsConfig, setAwayMinSeconds } from './config';
import { drainQueue, enqueueMessages, getBootId, requeueFront } from './state';

/**
 * design.md D2：ローカル backend への WS トランスポート。
 *
 * - 接続先: ws://127.0.0.1:<port>
 *   ※ 拡張からの WebSocket 接続は host_permissions 不要。host_permissions / CORS は
 *     fetch/XHR にのみ適用される。公式 WebSocket チュートリアルの manifest 例も
 *     minimum_chrome_version のみで host 権限を宣言していない。
 *     参照: https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
 * - open 時にまず hello（token/bootId/extVersion/tz）を送り、server の welcome を待って
 *   から送信待ちキューを flush する。
 * - 20秒周期の ping で SW の30秒アイドルタイマーをリセットしソケットを温存する
 *   （keepalive は setInterval：SW が生存している間のみ有効。停止後はアラームで復帰）。
 * - 切断時は指数バックオフ＋ジッタで再接続。切断中のサンプルは storage キューへ退避。
 */

const EXT_VERSION = chrome.runtime.getManifest().version;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const WS_STATUS_KEY = 'wsStatus';

/** popup 表示用に storage へ書き出す接続状態。 */
export interface WsStatus {
  connected: boolean;
  welcomed: boolean;
  lastError: string | null;
  lastConnectedTs: number | null;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private welcomed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  private status: WsStatus = {
    connected: false,
    welcomed: false,
    lastError: null,
    lastConnectedTs: null,
  };

  /** 未接続なら接続する（接続中/接続済みなら何もしない）。 */
  async connect(): Promise<void> {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.closedByUs = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const { wsPort } = await getWsConfig();
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${wsPort}${WS_PATH}`);
    } catch (err) {
      this.status.lastError = String(err);
      void this.persistStatus();
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      void this.onOpen();
    });
    socket.addEventListener('message', (ev) => {
      this.onMessage(ev);
    });
    socket.addEventListener('close', () => {
      this.onClose();
    });
    socket.addEventListener('error', () => {
      this.status.lastError = 'socket error';
      void this.persistStatus();
    });
  }

  /** 既存接続を畳んでから接続し直す（設定変更・onStartup 用）。 */
  async reconnect(): Promise<void> {
    this.teardown();
    await this.connect();
  }

  /** サンプルを送る。welcome 済みかつ OPEN なら即送信、そうでなければキューへ退避。 */
  async sendSample(sample: ActivitySample): Promise<void> {
    const message: SampleMessage = { type: 'sample', sample };
    await this.sendOrQueue(message);
  }

  /**
   * タブグループの改名イベントを送る（design D3・spec: tab-group-rename-tracking）。
   * `groups.ts` 側で静止5秒デバウンス済みの確定1件のみが呼ぶ。`ActivitySample` とは別メッセージ。
   */
  async sendGroupRename(
    from: { name: string; color: GroupColor },
    to: { name: string; color: GroupColor },
  ): Promise<void> {
    const message: GroupRenameMessage = { type: 'groupRename', from, to, at: Date.now() };
    await this.sendOrQueue(message);
  }

  /** welcome 済み+OPEN なら即送信、そうでなければ切断中キューへ退避（サンプル/改名で共有）。 */
  private async sendOrQueue(message: ClientMessage): Promise<void> {
    const serialized = JSON.stringify(message);
    if (this.welcomed && this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(serialized);
        return;
      } catch {
        // 送信に失敗したら退避へフォールバック。
      }
    }
    await enqueueMessages([serialized]);
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      void this.connect();
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async onOpen(): Promise<void> {
    this.reconnectAttempts = 0;
    this.status.connected = true;
    this.status.lastConnectedTs = Date.now();
    this.status.lastError = null;
    void this.persistStatus();

    const { sharedToken } = await getWsConfig();
    const bootId = await getBootId();
    const hello: HelloMessage = {
      type: 'hello',
      token: sharedToken,
      bootId,
      extVersion: EXT_VERSION,
      tz: TZ,
    };
    this.rawSend(hello);
    this.startKeepalive();
  }

  private onMessage(ev: MessageEvent): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome':
        this.welcomed = true;
        this.status.welcomed = true;
        // 復帰通知の閾値を永続（timeline-revamp D7）。optional のため未送信の旧サーバーとも互換。
        if (typeof msg.awayMinSeconds === 'number') void setAwayMinSeconds(msg.awayMinSeconds);
        void this.persistStatus();
        void this.flushQueue();
        break;
      case 'pong':
        break;
      case 'ack':
        break;
      case 'error':
        this.status.lastError = msg.reason;
        void this.persistStatus();
        break;
    }
  }

  private onClose(): void {
    this.welcomed = false;
    this.status.connected = false;
    this.status.welcomed = false;
    void this.persistStatus();
    this.stopKeepalive();
    this.socket = null;
    if (!this.closedByUs) this.scheduleReconnect();
  }

  /** 指数バックオフ（1s,2s,4s… 上限~30s）＋小ジッタで再接続を予約する。 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const base = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    const jitter = Math.floor(Math.random() * 500);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, base + jitter);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      const ping: PingMessage = { type: 'ping', clientTs: Date.now() };
      this.rawSend(ping);
    }, DEFAULTS.KEEPALIVE_SECONDS * 1000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** OPEN なら即送信し、成否を返す。 */
  private rawSend(msg: ClientMessage): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        this.status.lastError = String(err);
        return false;
      }
    }
    return false;
  }

  /** welcome 後にキューを順に flush する。途中で失敗したら残りを先頭へ戻す。 */
  private async flushQueue(): Promise<void> {
    const pending = await drainQueue();
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      if (item === undefined) continue;
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(item);
        } catch {
          await requeueFront(pending.slice(i));
          return;
        }
      } else {
        await requeueFront(pending.slice(i));
        return;
      }
    }
  }

  /** ソケット・タイマーを片付け、以後の自動再接続を止める。 */
  private teardown(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // 無視。
      }
      this.socket = null;
    }
    this.welcomed = false;
  }

  private async persistStatus(): Promise<void> {
    await chrome.storage.local.set({ [WS_STATUS_KEY]: { ...this.status } });
  }
}
