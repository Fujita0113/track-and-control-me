// 初回オンボーディング。ルールを足せる入口は目標作成時と振り返りタブの目標コーナーの2つだけ
// （spec: editable-rule-registry）。目標が1つも無ければ、まず目標タブへ誘導する。
import { api } from './api.js';
import { h, openModal, closeModal } from './util.js';

/** 目標が1つも無ければ誘導ダイアログを表示する。 */
export async function maybeShowOnboarding() {
  let goals;
  try {
    goals = await api.getGoals();
  } catch {
    return; // 取得失敗時は黙って何もしない(通常フローを妨げない)。
  }
  if (goals && goals.length) return;
  showDialog();
}

function showDialog() {
  const body = h('div', { class: 'modal-body' },
    h('p', {}, 'まだ目標がありません。'),
    h('p', { class: 'muted', text: '目標タブの「＋ 新しい目標」から、名前と一緒にその場でルール（守ること）を作れます。ルールを足せる場所は目標作成時と、振り返りタブの目標コーナーの2つだけです。' }),
  );
  const goBtn = h('button', { class: 'btn primary', text: '目標タブを開く', type: 'button' });
  goBtn.addEventListener('click', () => {
    closeModal();
    const tab = document.querySelector('.tab[data-target="goals"]');
    if (tab) tab.click();
  });
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', text: 'あとで', type: 'button', onclick: closeModal }),
    goBtn,
  ));
  body.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goBtn.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
  });
  openModal(body, '最初の目標を作りましょう');
  goBtn.focus();
}
