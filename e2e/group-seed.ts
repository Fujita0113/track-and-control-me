import type { Page } from '@playwright/test';

/**
 * `/ingest` WebSocket を通して実データ経路で group_identity を作る（issue 調査:
 * グループ選択 UI（GROUP_SELECT）の選択肢は実測セッションからしか生まれず、
 * 直接 INSERT する公開 API が無いため）。
 *
 * ブラウザの WebSocket API を `page.evaluate` 内から使う（Node 側に ws 依存を増やさない）。
 * グループごとに [開始, 終了) の2サンプルで65秒（60秒しきい値超）の区間を1本作り、
 * 次のグループとの間は120秒（gapCapMs=90秒超）空けて GAP_EXCEEDED にし、
 * 集計上ごちゃ混ぜにならないようにする（server/src/aggregation/aggregate.ts 参照）。
 */

export interface SeedGroup {
  title: string;
  color: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
}

export async function seedGroupIdentities(page: Page, groups: SeedGroup[]): Promise<void> {
  await page.evaluate(async (groupsArg) => {
    const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ingest`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ingest ws open failed')), { once: true });
    });

    const bootId = `e2e-group-seed-${crypto.randomUUID()}`;
    let seq = 0;

    await new Promise<void>((resolve, reject) => {
      const onMessage = (ev: MessageEvent): void => {
        const msg = JSON.parse(ev.data as string) as { type: string; reason?: string };
        if (msg.type === 'welcome') {
          ws.removeEventListener('message', onMessage);
          resolve();
        } else if (msg.type === 'error') {
          ws.removeEventListener('message', onMessage);
          reject(new Error(`ingest hello failed: ${msg.reason}`));
        }
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ type: 'hello', token: '', bootId, extVersion: '1.0.0-e2e', tz: 'Asia/Tokyo' }));
    });

    const STEP_MS = 65_000; // 60秒しきい値を確実に超える1区間の長さ。
    const GAP_MS = 120_000; // gapCapMs(90秒)超で GAP_EXCEEDED にし、次グループと混ざらないようにする。
    const baseTs = Date.now() - 3_600_000; // 日境界近傍を避けるため1時間前を起点にする。

    let ts = baseTs;
    const pending: Promise<void>[] = [];
    const sendAndWaitAck = (sample: Record<string, unknown>): Promise<void> =>
      new Promise((resolve, reject) => {
        const onMessage = (ev: MessageEvent): void => {
          const msg = JSON.parse(ev.data as string) as { type: string; seq?: number; reason?: string };
          if (msg.type === 'ack' && msg.seq === sample.seq) {
            ws.removeEventListener('message', onMessage);
            resolve();
          } else if (msg.type === 'error') {
            ws.removeEventListener('message', onMessage);
            reject(new Error(`ingest sample rejected: ${msg.reason}`));
          }
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ type: 'sample', sample }));
      });

    for (const g of groupsArg) {
      const stableGroupId = `e2e-${crypto.randomUUID()}`;
      const openGroupKeys = [{ groupId: 1, stableGroupId, title: g.title, color: g.color }];
      for (let i = 0; i < 2; i++) {
        const sample = {
          eventType: 'HEARTBEAT',
          clientTs: ts,
          monotonicMs: ts - baseTs,
          bootId,
          seq: seq++,
          tz: 'Asia/Tokyo',
          groupId: 1,
          stableGroupId,
          groupTitle: g.title,
          groupColor: g.color,
          windowId: 1,
          tabId: 1,
          idleState: 'active',
          browserFocused: true,
          openGroupKeys,
          extVersion: '1.0.0-e2e',
        };
        pending.push(sendAndWaitAck(sample));
        ts += STEP_MS;
      }
      ts += GAP_MS;
    }
    await Promise.all(pending);
    ws.close();
  }, groups);

  // ingest はデバウンス（3秒）後に再計算する（server/src/main.ts の schedulePipeline）。
  // /api/groups/recent に反映されるまでポーリングする。
  const deadline = Date.now() + 15_000;
  const titles = groups.map((g) => g.title);
  while (Date.now() < deadline) {
    const res = await page.request.get('/api/groups/recent');
    const list = (await res.json()) as { name: string }[];
    const names = new Set(list.map((g) => g.name));
    if (titles.every((t) => names.has(t))) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`group identities did not appear via /api/groups/recent: ${titles.join(', ')}`);
}
