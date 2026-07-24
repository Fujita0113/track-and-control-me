import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * groups.ts の純粋ロジック（stableGroupId 採番の不変条件・改名検出のデバウンス併合）を
 * 最小限の chrome.storage.local インメモリフェイクで検証する（spec: extension-stable-group-id /
 * tab-group-rename-tracking）。chrome.tabGroups / idle / windows 等の実ブラウザ API は
 * gatherState() のテストでのみ最小限モックする。
 */

interface FakeChromeStorage {
  data: Record<string, unknown>;
  local: {
    get: (keys?: string | string[]) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  };
}

function installFakeChrome(): FakeChromeStorage {
  const store: Record<string, unknown> = {};
  const fake: FakeChromeStorage = {
    data: store,
    local: {
      get: async (keys) => {
        if (keys === undefined) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (items) => {
        Object.assign(store, items);
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: fake.local },
    tabGroups: { query: async () => [] },
    idle: { queryState: async () => 'active' },
    windows: { getLastFocused: async () => ({ focused: true }) },
    tabs: { query: async () => [] },
  };
  return fake;
}

let fakeChrome: FakeChromeStorage;
beforeEach(() => {
  vi.resetModules();
  fakeChrome = installFakeChrome();
});
afterEach(() => {
  vi.useRealTimers();
});

async function loadGroups() {
  return import('./groups');
}

const BLUE = 'blue' as const;
const RED = 'red' as const;

function group(id: number, title: string, color: 'blue' | 'red' = BLUE): chrome.tabGroups.TabGroup {
  return { id, title, color, collapsed: false, windowId: 1 } as chrome.tabGroups.TabGroup;
}

describe('detectRenameCandidate / mergeRenamePending（純粋関数）', () => {
  it('直前 title が空（新規命名）では改名候補にならない', async () => {
    const { detectRenameCandidate } = await loadGroups();
    expect(detectRenameCandidate(undefined, '設計理解', BLUE)).toBeNull();
    expect(detectRenameCandidate({ stableId: 'x', title: '', color: BLUE }, '設計理解', BLUE)).toBeNull();
  });

  it('直前 title が非空で変化があれば改名候補になる', async () => {
    const { detectRenameCandidate } = await loadGroups();
    const r = detectRenameCandidate({ stableId: 'x', title: '競技プログラミング', color: RED }, '競プロ', RED);
    expect(r).toEqual({ from: { name: '競技プログラミング', color: RED }, to: { name: '競プロ', color: RED } });
  });

  it('変化が無ければ null', async () => {
    const { detectRenameCandidate } = await loadGroups();
    expect(detectRenameCandidate({ stableId: 'x', title: '開発', color: BLUE }, '開発', BLUE)).toBeNull();
  });

  it('mergeRenamePending: 連続更新で from は最初のまま・to だけ最新へ更新される', async () => {
    const { mergeRenamePending } = await loadGroups();
    let pending = mergeRenamePending(undefined, { from: { name: 'せ', color: RED }, to: { name: 'せっ', color: RED } });
    pending = mergeRenamePending(pending, { from: { name: 'せっ', color: RED }, to: { name: 'せっけ', color: RED } });
    pending = mergeRenamePending(pending, { from: { name: 'せっけ', color: RED }, to: { name: '設計理解', color: RED } });
    expect(pending).toEqual({ from: { name: 'せ', color: RED }, to: { name: '設計理解', color: RED } });
  });
});

describe('onGroupUpserted の改名デバウンス（design D3）', () => {
  it('入力途中の連続更新から改名イベントが1件だけ、確定後の組で送出される', async () => {
    vi.useFakeTimers();
    const { onGroupUpserted } = await loadGroups();
    const fired: unknown[] = [];
    const onRename = (pair: unknown) => {
      fired.push(pair);
    };

    // 新規グループへの命名（改名ではない）→ 送出されない。
    await onGroupUpserted(group(1, ''), onRename);
    await onGroupUpserted(group(1, 'せ'), onRename);
    // 改名（1文字ずつの onUpdated を模す）。
    await onGroupUpserted(group(1, 'せっ'), onRename);
    await onGroupUpserted(group(1, 'せっけ'), onRename);
    await onGroupUpserted(group(1, '設計理解'), onRename);

    expect(fired).toHaveLength(0); // まだデバウンス中。
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toEqual([{ from: { name: 'せ', color: BLUE }, to: { name: '設計理解', color: BLUE } }]);
  });

  it('新規グループへの命名では改名イベントが送信されない', async () => {
    vi.useFakeTimers();
    const { onGroupUpserted } = await loadGroups();
    const fired: unknown[] = [];
    await onGroupUpserted(group(2, ''), (p) => { fired.push(p); });
    await onGroupUpserted(group(2, '設計理解'), (p) => { fired.push(p); });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired).toHaveLength(0);
  });

  it('保留中の改名は SW ウェイク時（flushPendingRenames）に送出される', async () => {
    vi.useFakeTimers();
    const { onGroupUpserted, flushPendingRenames } = await loadGroups();
    // デバウンスタイマーは実 SW 再起動では失われるため、進めずに直接 flush する。
    await onGroupUpserted(group(3, '競技プログラミング', RED));
    await onGroupUpserted(group(3, '競プロ', RED), () => {
      /* このコールバックは onUpdated 経路のデバウンスに積むだけで、ここでは即座に呼ばれない */
    });

    const fired: unknown[] = [];
    await flushPendingRenames((p) => { fired.push(p); });
    expect(fired).toEqual([{ from: { name: '競技プログラミング', color: RED }, to: { name: '競プロ', color: RED } }]);

    // 一度 flush されたら保留は空になり、再度 flush しても何も出ない。
    const secondFlush: unknown[] = [];
    await flushPendingRenames((p) => { secondFlush.push(p); });
    expect(secondFlush).toHaveLength(0);
  });
});

describe('空タイトルは identity フォールバックを引かない・書かない（design D7-1）', () => {
  it('空タイトルのグループは byIdentity マップへ書き込まれず、既存 ID も引き当てない', async () => {
    const { onGroupUpserted } = await loadGroups();
    // 既存 ID を1つ用意（ブログ投稿・pink）。
    await onGroupUpserted(group(1, 'ブログ投稿', 'pink' as never));
    const before = await fakeChrome.local.get('groupIdentityMap');
    expect(before.groupIdentityMap).toEqual({ 'ブログ投稿 pink': expect.any(String) });

    // 新規グループ作成直後（title=''）を同じ色で観測しても、既存 ID を継承しない。
    await onGroupUpserted(group(2, '', 'pink' as never));
    const after = await fakeChrome.local.get(['groupStableMap', 'groupIdentityMap']);
    const map = after.groupStableMap as Record<string, { stableId: string }>;
    expect(map['1']!.stableId).not.toBe(map['2']!.stableId);
    // 空タイトルの組は byIdentity マップへ一切書き込まれない（「 pink」のようなキーが増えない）。
    expect(after.groupIdentityMap).toEqual({ 'ブログ投稿 pink': map['1']!.stableId });
  });
});

describe('stableGroupId 採番の不変条件（design D7・spec: extension-stable-group-id）', () => {
  it('空タイトルの2グループは別々の ID を持つ（既存 ID を継承しない）', async () => {
    const { onGroupUpserted, gatherState } = await loadGroups();
    // 既存 ID を1つ用意（ブログ投稿・pink）。
    await onGroupUpserted(group(1, 'ブログ投稿', 'blue'));

    (fakeChrome as unknown as { local: unknown }); // no-op（型維持）。
    (globalThis as unknown as { chrome: { tabGroups: { query: () => Promise<chrome.tabGroups.TabGroup[]> } } }).chrome.tabGroups.query =
      async () => [group(1, 'ブログ投稿', 'blue'), group(2, '', 'blue'), group(3, '', 'blue')];

    const state = await gatherState();
    const ids = state.openGroupKeys.map((g) => g.stableGroupId);
    expect(new Set(ids).size).toBe(3); // 3グループとも別 ID。
    // 無題2つ(2,3)は「ブログ投稿」のIDを継承していない。
    const blog = state.openGroupKeys.find((g) => g.groupId === 1)!.stableGroupId;
    const untitled2 = state.openGroupKeys.find((g) => g.groupId === 2)!.stableGroupId;
    const untitled3 = state.openGroupKeys.find((g) => g.groupId === 3)!.stableGroupId;
    expect(untitled2).not.toBe(blog);
    expect(untitled3).not.toBe(blog);
    expect(untitled2).not.toBe(untitled3);
  });

  it('写像の汚染により重複解決された場合、groupId が大きい方が再採番されて解消される', async () => {
    const { gatherState } = await loadGroups();
    // 汚染された写像を直接仕込む: groupId 10 と 20 が同じ stableId を共有している状態。
    await fakeChrome.local.set({
      groupStableMap: {
        '10': { stableId: 'dup-id', title: '面接', color: 'grey' },
        '20': { stableId: 'dup-id', title: '競技プログラミング', color: 'yellow' },
      },
    });
    (globalThis as unknown as { chrome: { tabGroups: { query: () => Promise<chrome.tabGroups.TabGroup[]> } } }).chrome.tabGroups.query =
      async () => [group(10, '面接', 'grey' as never), group(20, '競技プログラミング', 'yellow' as never)];

    const state = await gatherState();
    const ids = state.openGroupKeys.map((g) => g.stableGroupId);
    expect(new Set(ids).size).toBe(2); // 重複が解消されている。
    const kept = state.openGroupKeys.find((g) => g.groupId === 10)!.stableGroupId;
    const reassigned = state.openGroupKeys.find((g) => g.groupId === 20)!.stableGroupId;
    expect(kept).toBe('dup-id'); // 先に観測された方(groupId小)が既存IDを保持。
    expect(reassigned).not.toBe('dup-id'); // 後発(groupId大)が再採番される。
  });
});

describe('写像スキーマ版数（design D7-3）', () => {
  it('版数2以下の写像は migrateGroupMapsIfNeeded で消去される', async () => {
    await fakeChrome.local.set({
      groupMapSchemaVersion: 2,
      groupStableMap: { '1': { stableId: 'old', title: '汚染', color: 'blue' } },
      groupIdentityMap: { '汚染 blue': 'old' },
    });
    const { migrateGroupMapsIfNeeded } = await loadGroups();
    await migrateGroupMapsIfNeeded();
    const res = await fakeChrome.local.get(['groupStableMap', 'groupIdentityMap', 'groupMapSchemaVersion']);
    expect(res.groupStableMap).toEqual({});
    expect(res.groupIdentityMap).toEqual({});
    expect(res.groupMapSchemaVersion).toBe(3);
  });

  it('既に最新版数なら消去しない', async () => {
    await fakeChrome.local.set({
      groupMapSchemaVersion: 3,
      groupStableMap: { '1': { stableId: 'keep', title: '維持', color: 'blue' } },
    });
    const { migrateGroupMapsIfNeeded } = await loadGroups();
    await migrateGroupMapsIfNeeded();
    const res = await fakeChrome.local.get('groupStableMap');
    expect(res.groupStableMap).toEqual({ '1': { stableId: 'keep', title: '維持', color: 'blue' } });
  });
});
