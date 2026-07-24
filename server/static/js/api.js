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

  // 30日チャレンジ（目標）。ルールは目標作成時／振り返りタブの目標コーナーでのみ追加できる
  // （「採用」は廃止・今日タブに書き込み動線は無い・spec: editable-rule-registry）。
  getGoals: () => req('GET', '/api/goals'),
  getGoal: (id) => req('GET', `/api/goals/${id}`),
  // b = { name, purpose?, start?, rules: [{ target, ...contentFields, startDay?, endDay?, reason }] }
  createGoal: (b) => req('POST', '/api/goals', b),
  deleteGoal: (id) => req('DELETE', `/api/goals/${id}`),
  getGoalReport: (id) => req('GET', `/api/goals/${id}/report`),
  getGoalJournal: (id, date) => req('GET', `/api/goals/${id}/journal/${date}`),
  putGoalJournal: (id, date, content) => req('PUT', `/api/goals/${id}/journal/${date}`, { content }),

  // 目標コーナーのルール CRUD（全操作 reason 必須・design D4）。extend は延長フォークの回答
  // （'extend'|'truncate'、409 extensionRequired を受けての再送のみ使う）。
  addGoalRule: (goalId, input) => req('POST', `/api/goals/${goalId}/rules`, input),
  updateGoalRule: (goalId, ruleId, input) => req('PATCH', `/api/goals/${goalId}/rules/${ruleId}`, input),
  removeGoalRule: (goalId, ruleId, reason) => req('DELETE', `/api/goals/${goalId}/rules/${ruleId}`, { reason }),

  // 完走フォーク（続ける／終える・spec: goal-lifecycle-fork）
  continueGoal: (goalId) => req('POST', `/api/goals/${goalId}/continue`),
  endGoal: (goalId, reason) => req('POST', `/api/goals/${goalId}/end`, { reason }),

  // ⑤沿革（ルール操作の年表。日記は含まない）
  getGoalChronicle: (id) => req('GET', `/api/goals/${id}/chronicle`),

  // 目標日記の画像添付（バイナリ表示は URL 直指定: /api/goals/:id/journal/images/:imageId）
  listGoalJournalImages: (id, date) => req('GET', `/api/goals/${id}/journal/${date}/images`),
  addGoalJournalImage: (id, date, { dataUrl, caption }) =>
    req('POST', `/api/goals/${id}/journal/${date}/images`, { dataUrl, caption }),
  updateGoalJournalImageCaption: (id, imageId, caption) =>
    req('PATCH', `/api/goals/${id}/journal/images/${imageId}`, { caption }),
  deleteGoalJournalImage: (id, imageId) => req('DELETE', `/api/goals/${id}/journal/images/${imageId}`),

  // 写真/質問ルールへの回答（今日タブの不足条件・初回トースト・spec: goal-check-gate）
  getDueRules: (date) => req('GET', `/api/due-rules/${date}`),
  submitRulePhoto: (ruleId, { dataUrl, date, width, height }) =>
    req('POST', `/api/rules/${ruleId}/photo`, { dataUrl, date, width, height }),
  answerRuleQuestion: (ruleId, answerText, date) =>
    req('POST', `/api/rules/${ruleId}/answer`, { answerText, date }),

  // お試し（デモ）モード。閲覧は読み取り専用・本番ゲート非到達。now=仮想 day_key。
  // チュートリアル2動線（単発ルール通知・完走フォーク）だけはデモ DB への書き込みを許す
  // （spec: demo-rule-tutorial。実サーバー経路・デモ DB 限定・本番 DB には一切触れない）。
  demo: {
    reset: () => req('POST', '/api/demo/reset'),
    goals: (now) => req('GET', `/api/demo/goals?${q({ now })}`),
    goal: (id, now) => req('GET', `/api/demo/goals/${id}?${q({ now })}`),
    report: (id, now) => req('GET', `/api/demo/goals/${id}/report?${q({ now })}`),
    journal: (id, date) => req('GET', `/api/demo/goals/${id}/journal/${date}`),
    today: (now) => req('GET', `/api/demo/today?${q({ now })}`),
    allocation: (date) => req('GET', `/api/demo/timeline/${date}/allocation`),
    dueRules: (now) => req('GET', `/api/demo/due-rules?${q({ now })}`),
    chronicle: (id) => req('GET', `/api/demo/goals/${id}/chronicle`),
    // now = 呼び出し側が渡す state.demo.virtualDay（api.js は state.js を import しない設計のため明示で受け取る）。
    addGoalRule: (goalId, input, now) => req('POST', `/api/demo/goals/${goalId}/rules`, { ...input, now }),
    updateGoalRule: (goalId, ruleId, input, now) => req('PATCH', `/api/demo/goals/${goalId}/rules/${ruleId}`, { ...input, now }),
    removeGoalRule: (goalId, ruleId, reason, now) => req('DELETE', `/api/demo/goals/${goalId}/rules/${ruleId}`, { reason, now }),
    continueGoal: (goalId, now) => req('POST', `/api/demo/goals/${goalId}/continue`, { now }),
    endGoal: (goalId, reason, now) => req('POST', `/api/demo/goals/${goalId}/end`, { reason, now }),
  },
};
