// REST API クライアント。すべて same-origin fetch（connect-src 'self' 適合）。
// 4xx/5xx は Error を throw（err.status / err.data で詳細）。

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const q = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

export const api = {
  // 設定
  getConfig: () => req('GET', '/api/config'),
  patchConfig: (b) => req('PATCH', '/api/config', b),

  // グループ
  getGroups: () => req('GET', '/api/groups'),
  // 直近実測グループ（identity 単位・合計時間降順・spec: group-identity-registry）。
  getGroupsRecent: (days) => req('GET', `/api/groups/recent${days ? `?${q({ days })}` : ''}`),

  // 手動カテゴリ（記録ポップオーバーのチップ; 直近使用順）
  getCategories: () => req('GET', '/api/categories'),

  // サマリ
  getSummary: (date) => req('GET', date ? `/api/summary?${q({ date })}` : '/api/summary'),
  getRange: (from, to) => req('GET', `/api/summary/range?${q({ from, to })}`),

  // ルール
  getRules: () => req('GET', '/api/rules'),
  getRule: (date) => req('GET', `/api/rules/${date}`),
  putRule: (date, b) => req('PUT', `/api/rules/${date}`, b),
  deleteRule: (date) => req('DELETE', `/api/rules/${date}`),

  // 当日チェック
  getChecks: (date) => req('GET', `/api/checks/${date}`),
  putCheck: (date, conditionKey, checked) =>
    req('PUT', `/api/checks/${date}/${encodeURIComponent(conditionKey)}`, { checked }),

  // アンロック / パスワード
  getUnlock: (date) => req('GET', `/api/unlock/${date}`),
  reveal: (date) => req('POST', '/api/password/reveal', date ? { date } : {}),

  // タイムライン
  getTimeline: (date) => req('GET', date ? `/api/timeline/${date}` : '/api/timeline'),
  getAllocation: (date) => req('GET', `/api/timeline/${date}/allocation`),
  addManual: (date, b) => req('POST', `/api/timeline/${date}/manual`, b),
  patchEntry: (id, b) => req('PATCH', `/api/timeline/entry/${id}`, b),
  deleteEntry: (id) => req('DELETE', `/api/timeline/entry/${id}`),
  gapToAway: (date, b) => req('POST', `/api/timeline/${date}/gap-to-away`, b),
  putSplit: (date, b) => req('PUT', `/api/timeline/${date}/split`, b),

  // 振り返り / カンバン / PLANNING
  getReflections: () => req('GET', '/api/reflections'),
  getReflection: (date) => req('GET', `/api/reflection/${date}`),
  putReflection: (date, content, satisfaction = null) =>
    req('PUT', `/api/reflection/${date}`, { content, satisfaction }),
  getTasks: () => req('GET', '/api/tasks'),
  createTask: (b) => req('POST', '/api/tasks', b),
  updateTask: (id, b) => req('PATCH', `/api/tasks/${id}`, b),
  // 列内一括再インデックス。order = [{ status, ids: [...順序付き id] }, ...]
  reorder: (order) => req('POST', '/api/tasks/reorder', { order }),
  deleteTask: (id) => req('DELETE', `/api/tasks/${id}`),
  getPlanning: (date) => req('GET', `/api/planning/${date}`),

  // 30日チャレンジ（目標）
  getGoals: () => req('GET', '/api/goals'),
  // start = 'today' | 'tomorrow'（開始日の実効ルールから候補を出す・既定 today）
  getGoalCandidates: (start) =>
    req('GET', start ? `/api/goals/candidates?${q({ start })}` : '/api/goals/candidates'),
  createGoal: (b) => req('POST', '/api/goals', b),
  deleteGoal: (id) => req('DELETE', `/api/goals/${id}`),
  getGoalReport: (id) => req('GET', `/api/goals/${id}/report`),
  getGoalJournal: (id, date) => req('GET', `/api/goals/${id}/journal/${date}`),
  putGoalJournal: (id, date, content) => req('PUT', `/api/goals/${id}/journal/${date}`, { content }),

  // 目標日記の画像添付（バイナリ表示は URL 直指定: /api/goals/:id/journal/images/:imageId）
  listGoalJournalImages: (id, date) => req('GET', `/api/goals/${id}/journal/${date}/images`),
  addGoalJournalImage: (id, date, { dataUrl, caption }) =>
    req('POST', `/api/goals/${id}/journal/${date}/images`, { dataUrl, caption }),
  updateGoalJournalImageCaption: (id, imageId, caption) =>
    req('PATCH', `/api/goals/${id}/journal/images/${imageId}`, { caption }),
  deleteGoalJournalImage: (id, imageId) => req('DELETE', `/api/goals/${id}/journal/images/${imageId}`),

  // Plan（賭け）/ Check（答え合わせ）。Check は 種類（photo|question）× いつ（single|range）の独立2軸。
  getGoalPlans: (id) => req('GET', `/api/goals/${id}/plans`),
  createGoalPlan: (id, body) => req('POST', `/api/goals/${id}/plans`, { body }),
  getGoalChronicle: (id) => req('GET', `/api/goals/${id}/chronicle`),
  // check = { kind, caption|questionText, schedule, startDayKey|startInDays, spanDays?, placeNote?, timeNote? }
  createGoalCheck: (planId, check) => req('POST', `/api/goals/plans/${planId}/checks`, check),
  withdrawGoalPlan: (planId, reason) => req('POST', `/api/goals/plans/${planId}/withdraw`, { reason }),
  // その日に回答すべき Check（今日タブの不足条件・初回トースト）
  getDueChecks: (date) => req('GET', `/api/goal-checks/due/${date}`),
  // 写真提出（キャプションは先指定のため送らない）
  submitCheckPhoto: (checkId, { dataUrl, date, width, height }) =>
    req('POST', `/api/goal-checks/${checkId}/photo`, { dataUrl, date, width, height }),
  answerCheck: (checkId, answerText, date) =>
    req('POST', `/api/goal-checks/${checkId}/answer`, { answerText, date }),
  cancelCheck: (checkId, reason) => req('POST', `/api/goal-checks/${checkId}/cancel`, { reason }),

  // お試し（デモ）モード（読み取り専用・本番ゲート非到達）。now=仮想 day_key。
  demo: {
    reset: () => req('POST', '/api/demo/reset'),
    goals: (now) => req('GET', `/api/demo/goals?${q({ now })}`),
    report: (id, now) => req('GET', `/api/demo/goals/${id}/report?${q({ now })}`),
    journal: (id, date) => req('GET', `/api/demo/goals/${id}/journal/${date}`),
    today: (now) => req('GET', `/api/demo/today?${q({ now })}`),
    allocation: (date) => req('GET', `/api/demo/timeline/${date}/allocation`),
  },
};
