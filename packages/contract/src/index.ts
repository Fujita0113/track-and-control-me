import { z } from 'zod';

/**
 * 拡張(MV3 Service Worker) と backend(Fastify) が共有する契約。
 * ハートビート/遷移イベントのペイロード、WS プロトコルのメッセージ、
 * そして双方が一致していなければならない既定定数を定義する。
 *
 * design.md D3 / D5 に対応（型の drift を1スキーマで防ぐ）。
 */

// chrome.tabGroups.TAB_GROUP_ID_NONE / chrome.windows.WINDOW_ID_NONE
export const TAB_GROUP_ID_NONE = -1;
export const WINDOW_ID_NONE = -1;

/** WS ingest エンドポイントのパス。拡張と server が共有し、drift を防ぐ。 */
export const WS_PATH = '/ingest';

/** 分配・集計・延命に関わる既定値（AppConfig で上書き可能）。 */
export const DEFAULTS = {
  /** ハートビート周期（秒）。現行 Chromium の chrome.alarms 実質下限。 */
  HEARTBEAT_SECONDS: 30,
  /** chrome.idle.setDetectionInterval（秒）。 */
  IDLE_DETECTION_SECONDS: 30,
  /** gap がこの秒数を超えたら計上しない（スリープ/終了とみなす）。=30s*3 */
  GAP_CAP_SECONDS: 90,
  /** 1日の境界（ローカル時刻 HH:mm）。0:00〜この時刻は前日扱い。 */
  DAY_BOUNDARY_LOCAL_TIME: '04:00',
  /** WS アプリレベルキープアライブ周期（秒）。SW の30秒アイドルより短く。 */
  KEEPALIVE_SECONDS: 20,
  /** backend の待受ポート（127.0.0.1 バインド）。 */
  WS_PORT: 47653,
} as const;

/** chrome.idle の状態。'idle'|'locked' は非計上、'active' のみ計上。 */
export const IdleStateSchema = z.enum(['active', 'idle', 'locked']);
export type IdleState = z.infer<typeof IdleStateSchema>;

/** chrome.tabGroups.Color。タイムラインのブロック色に用いる。 */
export const GroupColorSchema = z.enum([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);
export type GroupColor = z.infer<typeof GroupColorSchema>;

/** イベント種別（ハートビート＋遷移イベント。design.md D3）。 */
export const EventTypeSchema = z.enum([
  'HEARTBEAT',
  'TAB_ACTIVATED',
  'TAB_GROUP_CHANGED',
  'GROUP_UPDATED',
  'GROUP_REMOVED',
  'WINDOW_FOCUS_CHANGED',
  'IDLE_STATE_CHANGED',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * openGroupKeys の要素。「その時点で開いている各タブグループ」への参照。
 * divide-by-N の分母集合であり、backend が未知グループを登録できるよう
 * title/color も併送する。
 */
export const GroupRefSchema = z.object({
  /** 揮発的な chrome groupId（再起動で振り直される。ヒント用）。 */
  groupId: z.number().int(),
  /** 安定キー（chrome.storage 永続 UUID）。集計の主キー。 */
  stableGroupId: z.string().min(1),
  /** グループ名（空文字可＝無題グループ）。 */
  title: z.string(),
  /** グループ色。 */
  color: GroupColorSchema,
});
export type GroupRef = z.infer<typeof GroupRefSchema>;

/**
 * アクティビティサンプル（ハートビートまたは遷移イベント1件）。
 * backend はこの列を (bootId, seq) でソート・重複排除し、連続ペアを区間化する。
 */
export const ActivitySampleSchema = z.object({
  eventType: EventTypeSchema,
  /** クライアント壁時計（epoch ms）。区間長の一次ソース。 */
  clientTs: z.number().int().nonnegative(),
  /** 単調時計（performance.now ベース）。時計ジャンプ検出用。 */
  monotonicMs: z.number().nonnegative(),
  /** SW ブート毎に発行する UUID。seq と組で冪等キー。 */
  bootId: z.string().min(1),
  /** bootId 内で単調増加するシーケンス番号。 */
  seq: z.number().int().nonnegative(),
  /** IANA タイムゾーン（例 "Asia/Tokyo"）。日帰属の導出に使う。 */
  tz: z.string().min(1),

  /** アクティブタブのグループ。-1 = TAB_GROUP_ID_NONE（未グループ）。 */
  groupId: z.number().int(),
  /** アクティブグループの安定キー。未グループ/アクティブ無しは null。 */
  stableGroupId: z.string().min(1).nullable(),
  /** アクティブグループ名。未グループは null。 */
  groupTitle: z.string().nullable(),
  /** アクティブグループ色。未グループは null。 */
  groupColor: GroupColorSchema.nullable(),

  /** アクティブタブの window id。WINDOW_ID_NONE = 全ウィンドウ非フォーカス。 */
  windowId: z.number().int(),
  /** アクティブタブ id。無い場合は null。 */
  tabId: z.number().int().nullable(),

  /** 在席状態。'active' のみ計上対象。 */
  idleState: IdleStateSchema,
  /** Edge が最前面か。※計上停止条件にはしない（design.md D4）。 */
  browserFocused: z.boolean(),

  /** 現在開いている全グループ集合（divide-by-N の分母）。 */
  openGroupKeys: z.array(GroupRefSchema),

  /** 拡張バージョン（manifest.version）。 */
  extVersion: z.string().min(1),
});
export type ActivitySample = z.infer<typeof ActivitySampleSchema>;

// ---------------------------------------------------------------------------
// WS プロトコル（拡張 → backend、および backend → 拡張の応答）
// ---------------------------------------------------------------------------

/** 接続直後に一度だけ送る認証ハンドシェイク。 */
export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  // 空文字を許可（dev モード）。実際の照合は server 側で設定トークンと比較する。
  token: z.string(),
  bootId: z.string().min(1),
  extVersion: z.string().min(1),
  tz: z.string().min(1),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

/** サンプル1件の送信。 */
export const SampleMessageSchema = z.object({
  type: z.literal('sample'),
  sample: ActivitySampleSchema,
});
export type SampleMessage = z.infer<typeof SampleMessageSchema>;

/** アプリレベルキープアライブ（SW の30秒アイドルタイマーをリセット）。 */
export const PingMessageSchema = z.object({
  type: z.literal('ping'),
  clientTs: z.number().int().nonnegative(),
});
export type PingMessage = z.infer<typeof PingMessageSchema>;

/** 拡張 → backend のメッセージ（判別 union）。 */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  SampleMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** backend → 拡張のメッセージ（判別 union）。 */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), serverTime: z.number().int() }),
  z.object({ type: z.literal('pong'), serverTime: z.number().int() }),
  z.object({
    type: z.literal('ack'),
    bootId: z.string(),
    seq: z.number().int(),
  }),
  z.object({ type: z.literal('error'), reason: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** 未グループ区間の予約バケットキー（"その他"）。 */
export const UNGROUPED_KEY = 'ungrouped';
