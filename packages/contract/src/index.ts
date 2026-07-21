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
// Plan / Check（spec: goal-plan-check / goal-check-gate / goal-chronicle）
// ---------------------------------------------------------------------------

/** day_key の形（'YYYY-MM-DD'）。 */
const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day_key は YYYY-MM-DD 形式');

/** 非空テキスト（trim 後に1文字以上）。本文・理由・答え・キャプション・質問文が共有する。 */
const NonEmptyText = z.string().transform((s) => s.trim()).pipe(z.string().min(1));

/**
 * Check の**種類**（軸1）。「いつ」（schedule）とは独立で、種類が「いつ」を決めることはない。
 * photo=📷 写真を投稿する / question=💬 質問に答える。
 */
export const CheckKindSchema = z.enum(['photo', 'question']);
export type CheckKind = z.infer<typeof CheckKindSchema>;

/**
 * Check の**いつ**（軸2）。「種類」（kind）とは独立。
 * single=単発（達成するまでロックを繰り越す）/ range=範囲（その日限り・繰り越さない）。
 */
export const CheckScheduleSchema = z.enum(['single', 'range']);
export type CheckSchedule = z.infer<typeof CheckScheduleSchema>;

/** Plan の状態。withdrawn は終端（理由つきで沿革に残す）。 */
export const PlanStatusSchema = z.enum(['active', 'withdrawn']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

/**
 * Check の永続状態。達成（satisfied）は**永続化しない**＝対象日から遅延導出する（design D2）。
 * ここに載るのは終端の cancelled と既定の active のみ。
 */
export const CheckStatusSchema = z.enum(['active', 'cancelled']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** Check への回答1件（写真なら imageId、質問なら answerText）。 */
export const GoalCheckResultSchema = z.object({
  id: z.number().int(),
  checkId: z.number().int(),
  dayKey: DayKeySchema,
  imageId: z.number().int().nullable(),
  answerText: z.string().nullable(),
  createdAt: z.number().int(),
});
export type GoalCheckResult = z.infer<typeof GoalCheckResultSchema>;

/**
 * Check（答え合わせ）。種類×いつ の2軸は独立し、全4通りが表現できる。
 * placeNote / timeNote は説明メタデータのみで判定には一切用いない（design D8）。
 */
export const GoalCheckSchema = z.object({
  id: z.number().int(),
  planId: z.number().int(),
  kind: CheckKindSchema,
  /** kind=photo のとき非空（先指定・変更不可）。question のときは空文字。 */
  caption: z.string(),
  /** kind=question のとき非空。photo のときは空文字。 */
  questionText: z.string(),
  schedule: CheckScheduleSchema,
  startDayKey: DayKeySchema,
  /** schedule=range のとき 2 以上。single は null。 */
  spanDays: z.number().int().min(2).nullable(),
  placeNote: z.string().nullable(),
  timeNote: z.string().nullable(),
  status: CheckStatusSchema,
  cancelReason: z.string().nullable(),
  createdAt: z.number().int(),
  results: z.array(GoalCheckResultSchema),
});
export type GoalCheck = z.infer<typeof GoalCheckSchema>;

/** Plan（賭け）。種別カラムは持たない（本文を読めば分かる）。Check は0個以上。 */
export const GoalPlanSchema = z.object({
  id: z.number().int(),
  goalId: z.number().int(),
  dayKey: DayKeySchema,
  body: z.string(),
  status: PlanStatusSchema,
  withdrawReason: z.string().nullable(),
  createdAt: z.number().int(),
  checks: z.array(GoalCheckSchema),
});
export type GoalPlan = z.infer<typeof GoalPlanSchema>;

// --- 入力（作成・回答・取り下げ）------------------------------------------

/** Plan 作成入力。本文のみ（種別は無い）。 */
export const CreatePlanInputSchema = z.object({
  body: NonEmptyText,
});
export type CreatePlanInput = z.infer<typeof CreatePlanInputSchema>;

/**
 * Check 作成入力。種類×いつ の2軸を型で担保する判別 union。
 * 「いつ」は `startDayKey`（絶対）または `startInDays`（相対「3日後」）のどちらでも入力でき、
 * サーバー側で固定 `startDayKey` へ解決する。
 */
const WhenSchema = z.union([
  z.object({ schedule: z.literal('single'), startDayKey: DayKeySchema, startInDays: z.undefined().optional() }),
  z.object({ schedule: z.literal('single'), startInDays: z.number().int().nonnegative(), startDayKey: z.undefined().optional() }),
  z.object({
    schedule: z.literal('range'),
    startDayKey: DayKeySchema,
    startInDays: z.undefined().optional(),
    spanDays: z.number().int().min(2),
  }),
  z.object({
    schedule: z.literal('range'),
    startInDays: z.number().int().nonnegative(),
    startDayKey: z.undefined().optional(),
    spanDays: z.number().int().min(2),
  }),
]);

const KindSchema = z.union([
  z.object({ kind: z.literal('photo'), caption: NonEmptyText }),
  z.object({ kind: z.literal('question'), questionText: NonEmptyText }),
]);

const NotesSchema = z.object({
  placeNote: z.string().trim().optional(),
  timeNote: z.string().trim().optional(),
});

/**
 * Check 作成入力＝ 種類 × いつ × メモ の交差。2軸が独立していることを型で担保する
 * （photo×range・question×single を含む全4通りが等しく組める）。
 */
export const CreateCheckInputSchema = z.intersection(z.intersection(KindSchema, WhenSchema), NotesSchema);
export type CreateCheckInput = z.infer<typeof CreateCheckInputSchema>;

/** 写真Check への提出（キャプションは先指定のため受け取らない）。 */
export const SubmitPhotoInputSchema = z.object({
  dataUrl: z.string().min(1),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
});
export type SubmitPhotoInput = z.infer<typeof SubmitPhotoInputSchema>;

/** 質問Check への回答（空回答は拒否）。 */
export const AnswerQuestionInputSchema = z.object({
  answerText: NonEmptyText,
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInputSchema>;

/** 取り下げ入力（Plan / Check 共通）。理由は非空必須＝唯一の脱出弁の代償（design D9）。 */
export const WithdrawInputSchema = z.object({
  reason: NonEmptyText,
});
export type WithdrawInput = z.infer<typeof WithdrawInputSchema>;

// --- 沿革・今日の Check（出力）---------------------------------------------

/** 沿革（⑤）＝ Plan を day_key 昇順・同日内は記録順で並べ、Check を入れ子に持つ。日記は含めない。 */
export const ChronicleSchema = z.object({
  goalId: z.number().int(),
  plans: z.array(GoalPlanSchema),
});
export type Chronicle = z.infer<typeof ChronicleSchema>;

/** その日に回答すべき Check 1件（今日タブの不足条件行・初回トーストが使う）。 */
export const DueCheckSchema = z.object({
  checkId: z.number().int(),
  planId: z.number().int(),
  goalId: z.number().int(),
  goalName: z.string(),
  planBody: z.string(),
  kind: CheckKindSchema,
  schedule: CheckScheduleSchema,
  /** 表示ラベル＝写真はキャプション／質問は質問文。 */
  label: z.string(),
  caption: z.string(),
  questionText: z.string(),
  placeNote: z.string().nullable(),
  timeNote: z.string().nullable(),
  startDayKey: DayKeySchema,
  /** 範囲Check のとき「N日中の何日目か」（1 始まり）。単発は null。 */
  rangeDayNumber: z.number().int().nullable(),
  spanDays: z.number().int().nullable(),
});
export type DueCheck = z.infer<typeof DueCheckSchema>;

/** 「その日に回答すべき Check があるか」（トースト用エンドポイントの応答）。 */
export const DueChecksResponseSchema = z.object({
  dayKey: DayKeySchema,
  checks: z.array(DueCheckSchema),
});
export type DueChecksResponse = z.infer<typeof DueChecksResponseSchema>;

/** 合成条件の condition_key 名前空間（既存の total_work/group:/timeline:/manual:/planning: と衝突しない）。 */
export const CHECK_CONDITION_PREFIX = 'check:';
/** Check の合成条件 target（既存 RuleTarget とは別枠）。 */
export const CHECK_TARGET = 'CHECK';
