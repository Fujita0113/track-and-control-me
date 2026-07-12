import { DEFAULTS } from '@track/contract';
import { getWsConfig, setWsConfig } from './config';
import { loadSnapshot } from './state';
import type { WsStatus } from './ws-client';

/**
 * popup：WS ポート/トークンの表示・設定と、接続状態・アクティブグループ・
 * 開いているグループの表示（design.md 「popup」）。CSP セーフ（外部 popup.js のみ）。
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node as T;
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

async function readStatus(): Promise<WsStatus | null> {
  const res = await chrome.storage.local.get('wsStatus');
  const s = res['wsStatus'] as WsStatus | undefined;
  return s ?? null;
}

async function render(): Promise<void> {
  const cfg = await getWsConfig();
  el<HTMLInputElement>('port').value = String(cfg.wsPort);
  el<HTMLInputElement>('token').value = cfg.sharedToken;

  // トークン未設定の警告。
  const warn = el<HTMLElement>('token-warning');
  warn.style.display = cfg.sharedToken.length === 0 ? 'block' : 'none';

  // 接続状態。
  const status = await readStatus();
  const dot = el<HTMLElement>('conn-dot');
  const label = el<HTMLElement>('conn-label');
  const connected = status?.connected === true;
  const welcomed = status?.welcomed === true;
  dot.className = 'dot ' + (connected && welcomed ? 'ok' : connected ? 'warn' : 'ng');
  label.textContent = connected
    ? welcomed
      ? '接続済み'
      : '接続中（welcome 待ち）'
    : '未接続';
  el<HTMLElement>('last-connected').textContent = fmtTime(status?.lastConnectedTs ?? null);
  el<HTMLElement>('last-error').textContent = status?.lastError ?? '—';

  // スナップショット（最終ハートビート・アクティブ/開いているグループ）。
  const snap = await loadSnapshot();
  el<HTMLElement>('last-heartbeat').textContent = fmtTime(snap?.lastHeartbeatTs ?? null);
  el<HTMLElement>('idle-state').textContent = snap?.idleState ?? '—';

  const activeLabel =
    snap == null
      ? '—'
      : snap.stableGroupId == null
        ? '（未グループ）'
        : `${snap.title || '（無題）'} [${snap.color ?? '?'}]`;
  el<HTMLElement>('active-group').textContent = activeLabel;

  const list = el<HTMLUListElement>('open-groups');
  list.textContent = '';
  const groups = snap?.openGroupKeys ?? [];
  if (groups.length === 0) {
    const li = document.createElement('li');
    li.textContent = '（なし）';
    list.appendChild(li);
  } else {
    for (const g of groups) {
      const li = document.createElement('li');
      li.textContent = `${g.title || '（無題）'} [${g.color}]`;
      list.appendChild(li);
    }
  }
}

async function save(): Promise<void> {
  const portRaw = el<HTMLInputElement>('port').value;
  const token = el<HTMLInputElement>('token').value;
  const parsed = Number.parseInt(portRaw, 10);
  const wsPort = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULTS.WS_PORT;
  await setWsConfig({ wsPort, sharedToken: token });
  // SW が生きていれば即再接続させる（寝ていれば次回接続時に反映）。
  try {
    await chrome.runtime.sendMessage({ type: 'applyConfig' });
  } catch {
    // 受け手が居ない場合は無視。
  }
  await render();
}

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLButtonElement>('save').addEventListener('click', () => {
    void save();
  });
  // #port / #token での Enter で保存して再接続。IME 変換確定 Enter（主に #token）は無視する。
  const submitOnEnter = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };
  el<HTMLInputElement>('port').addEventListener('keydown', submitOnEnter);
  el<HTMLInputElement>('token').addEventListener('keydown', submitOnEnter);
  void render();
  // popup 表示中は状態を軽くポーリングして更新する。
  setInterval(() => {
    void render();
  }, 2000);
});
