import { DEFAULTS } from '@track/contract';

/**
 * popup と Service Worker が共有する WS 接続設定。
 * chrome.storage.local の `wsConfig` キーに永続する（design.md 「共有トークン＋ポートブートストラップ」）。
 */
export interface WsConfig {
  /** backend の待受ポート。既定は DEFAULTS.WS_PORT。 */
  wsPort: number;
  /** 共有トークン。空文字許容（dev の既定受理を試みる）。 */
  sharedToken: string;
}

const WS_CONFIG_KEY = 'wsConfig';
const AWAY_MIN_SECONDS_KEY = 'awayMinSeconds';

/** 保存済み設定を読む。未設定・不正値は DEFAULTS / 空文字で補完する。 */
export async function getWsConfig(): Promise<WsConfig> {
  const res = await chrome.storage.local.get(WS_CONFIG_KEY);
  const stored = res[WS_CONFIG_KEY] as Partial<WsConfig> | undefined;
  const port = stored?.wsPort;
  const token = stored?.sharedToken;
  return {
    wsPort: typeof port === 'number' && Number.isFinite(port) ? port : DEFAULTS.WS_PORT,
    sharedToken: typeof token === 'string' ? token : '',
  };
}

/** 設定を保存する。 */
export async function setWsConfig(config: WsConfig): Promise<void> {
  await chrome.storage.local.set({ [WS_CONFIG_KEY]: config });
}

/**
 * 復帰通知の閾値（秒）。サーバー設定 `away_min_seconds` を権威とし、WS の welcome で受領する
 * （timeline-revamp D7）。ws-client が受領時に永続する。
 */
export async function setAwayMinSeconds(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  await chrome.storage.local.set({ [AWAY_MIN_SECONDS_KEY]: Math.round(seconds) });
}

/** 保存済み閾値（秒）。未受領（未接続・旧サーバー）時は契約既定値へフォールバック。 */
export async function getAwayMinSeconds(): Promise<number> {
  const res = await chrome.storage.local.get(AWAY_MIN_SECONDS_KEY);
  const v = res[AWAY_MIN_SECONDS_KEY];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULTS.AWAY_MIN_SECONDS;
}
