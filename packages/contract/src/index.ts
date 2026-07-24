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
  /**
   * 「記録すべき離席」の最小秒数（timeline-revamp D2 の一元化閾値）。
   * サーバーのギャップ抽出・クライアントのラン結合・拡張の復帰通知が共有する。
   * 権威はサーバー設定 `away_min_seconds`。拡張は welcome 未受領時にこの値へフォールバック。
   */
  AWAY_MIN_SECONDS: 600,
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

/**
 * イベント種別（ハートビート＋遷移イベント。design.md D3）。
 * `GROUP_RENAMED` はタブグループの改名検出（spec: tab-group-rename-tracking）を表す種別として
 * 追加する。改名は `ActivitySample.eventType` としては流れない（サンプル側は従来どおり
 * `GROUP_UPDATED`）。`GROUP_RENAMED` は改名専用メッセージ（`GroupRenameMessage`）や
 * サーバー側ログが参照する事象タグとして使う。
 */
export const EventTypeSchema = z.enum([
  'HEARTBEAT',
  'TAB_ACTIVATED',
  'TAB_GROUP_CHANGED',
  'GROUP_UPDATED',
  'GROUP_REMOVED',
  'GROUP_RENAMED',
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

/** タブグループ改名の (旧名,旧色) → (新名,新色) の組。 */
export const GroupNameColorSchema = z.object({
  name: z.string(),
  color: GroupColorSchema,
});

/**
 * タブグループの改名イベント（design.md D3・spec: tab-group-rename-tracking）。
 * `ActivitySample` とは別のメッセージとして送る（区間化の入力に意味の異なる制御イベントを混入させない）。
 * 拡張側で静止5秒デバウンス済みの確定 1 件のみが送られる。
 */
export const GroupRenameMessageSchema = z.object({
  type: z.literal('groupRename'),
  from: GroupNameColorSchema,
  to: GroupNameColorSchema,
  at: z.number().int(),
});
export type GroupRenameMessage = z.infer<typeof GroupRenameMessageSchema>;

/** 拡張 → backend のメッセージ（判別 union）。 */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  SampleMessageSchema,
  PingMessageSchema,
  GroupRenameMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** backend → 拡張のメッセージ（判別 union）。 */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  // welcome は接続確立時に一度だけ。awayMinSeconds はサーバー設定の配布（timeline-revamp D7）。
  // optional のため旧サーバー（未送信）とも後方互換。
  z.object({
    type: z.literal('welcome'),
    serverTime: z.number().int(),
    awayMinSeconds: z.number().int().positive().optional(),
  }),
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

// ---------------------------------------------------------------------------
// 解錠ルール（spec: editable-rule-registry / goal-check-gate / goal-chronicle /
// goal-lifecycle-fork）。Plan / Check の語彙・モデルは撤去済み（goal-plan-check REMOVED）。
// ---------------------------------------------------------------------------

/** day_key の形（'YYYY-MM-DD'）。 */
const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day_key は YYYY-MM-DD 形式');

/** 非空テキスト（trim 後に1文字以上）。理由・答え・キャプション・質問文が共有する。 */
const NonEmptyText = z.string().transform((s) => s.trim()).pipe(z.string().min(1));

/** ルールの種類（軸1）。写真(📷)・質問(💬) は「いつ」（軸2）とは独立。 */
export const RuleTargetSchema = z.enum(['TOTAL_WORK', 'GROUP', 'TIMELINE', 'MANUAL_CHECK', 'PLANNING', 'PHOTO', 'QUESTION']);
export type RuleTarget = z.infer<typeof RuleTargetSchema>;

/** ルールの「いつ」（軸2）。permanent=永続(end_day=null) / single=単発(start=end) / range=範囲(start<end)。 */
export const RuleScheduleSchema = z.enum(['permanent', 'single', 'range']);
export type RuleSchedule = z.infer<typeof RuleScheduleSchema>;

/** ルール操作の種別。追加・変更・削除はどれも理由必須（design D4）。 */
export const RuleOpSchema = z.enum(['add', 'update', 'remove']);
export type RuleOp = z.infer<typeof RuleOpSchema>;

/** ルール操作の理由（追加・変更・削除で共通・design D4）。 */
export const RuleReasonInputSchema = z.object({ reason: NonEmptyText });
export type RuleReasonInput = z.infer<typeof RuleReasonInputSchema>;

/** 写真ルールへの提出（キャプションは先指定のため受け取らない）。 */
export const SubmitPhotoInputSchema = z.object({
  dataUrl: z.string().min(1),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
});
export type SubmitPhotoInput = z.infer<typeof SubmitPhotoInputSchema>;

/** 質問ルールへの回答（空回答は拒否）。 */
export const AnswerQuestionInputSchema = z.object({
  answerText: NonEmptyText,
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInputSchema>;

// --- 沿革（⑤）--------------------------------------------------------------

/** ルール操作1件（`rule_change` 由来）。 */
export const RuleChangeSchema = z.object({
  id: z.number().int(),
  ruleId: z.number().int(),
  dayKey: DayKeySchema,
  /** 目標の Day 番号（沿革表示用）。目標に紐づかない文脈では null。 */
  dayNumber: z.number().int().nullable(),
  op: RuleOpSchema,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string(),
  createdAt: z.number().int(),
});
export type RuleChangeEntry = z.infer<typeof RuleChangeSchema>;

/** ルールへの回答1件（写真なら imageId、質問なら answerText）。 */
export const RuleAnswerSchema = z.object({
  id: z.number().int(),
  ruleId: z.number().int(),
  dayKey: DayKeySchema,
  dayNumber: z.number().int().nullable(),
  imageId: z.number().int().nullable(),
  answerText: z.string().nullable(),
  createdAt: z.number().int(),
});
export type RuleAnswer = z.infer<typeof RuleAnswerSchema>;

/**
 * 沿革1件＝ルール操作とその理由。写真ルール・質問ルールの `op='add'` エントリには、
 * そのルールの答え合わせ全件がぶら下がる（design: goal-chronicle）。
 */
export const ChronicleEntrySchema = z.object({
  ruleId: z.number().int(),
  target: RuleTargetSchema,
  label: z.string(),
  change: RuleChangeSchema,
  answers: z.array(RuleAnswerSchema),
});
export type ChronicleEntry = z.infer<typeof ChronicleEntrySchema>;

/** 完走フォークで理由つきに「終える」を選んだときの最終エントリ（design D7）。 */
export const ChronicleEndedNoteSchema = z.object({
  reason: z.string(),
  dayNumber: z.number().int(),
});

/** 沿革（⑤）＝ルール操作の年表（`day_key` 昇順・同日内は記録順）。日記は含めない。 */
export const ChronicleSchema = z.object({
  goalId: z.number().int(),
  entries: z.array(ChronicleEntrySchema),
  endedNote: ChronicleEndedNoteSchema.nullable(),
});
export type Chronicle = z.infer<typeof ChronicleSchema>;

// --- 今日の不足ルール（今日タブ・初回トースト）------------------------------

/** その日に回答すべき写真/質問ルール1件（今日タブの不足条件行・初回トーストが使う）。 */
export const DueRuleSchema = z.object({
  ruleId: z.number().int(),
  goalId: z.number().int().nullable(),
  goalName: z.string().nullable(),
  target: z.enum(['PHOTO', 'QUESTION']),
  /** 表示ラベル＝写真はキャプション／質問は質問文。 */
  label: z.string(),
  schedule: RuleScheduleSchema,
  startDay: DayKeySchema,
  endDay: DayKeySchema.nullable(),
  /** 範囲ルールのとき「N日中の何日目か」（1 始まり）。単発・永続は null。 */
  rangeDayNumber: z.number().int().nullable(),
  spanDays: z.number().int().nullable(),
});
export type DueRule = z.infer<typeof DueRuleSchema>;

/** 「その日に回答すべきルールがあるか」（トースト用エンドポイントの応答）。 */
export const DueRulesResponseSchema = z.object({
  dayKey: DayKeySchema,
  rules: z.array(DueRuleSchema),
});
export type DueRulesResponse = z.infer<typeof DueRulesResponseSchema>;
