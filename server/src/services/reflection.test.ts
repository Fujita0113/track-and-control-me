import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { saveReflection, listReflections, reflectionExcerpt } from './reflection.js';

describe('reflectionExcerpt', () => {
  it('Markdown 記号を除去し空白を圧縮する', () => {
    expect(reflectionExcerpt('# 見出し\n- **重要** な `点`')).toBe('見出し 重要 な 点');
  });

  it('先頭 80 字に切り詰める', () => {
    const long = 'あ'.repeat(200);
    const out = reflectionExcerpt(long);
    expect(out).toHaveLength(80);
    expect(out).toBe('あ'.repeat(80));
  });

  it('null/空は空文字', () => {
    expect(reflectionExcerpt('')).toBe('');
    expect(reflectionExcerpt(undefined as unknown as string)).toBe('');
    expect(reflectionExcerpt('   \n  ')).toBe('');
  });
});

describe('listReflections', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('新しい日付順で抜粋付き・本文全文は含めない', () => {
    saveReflection(db, '2026-07-07', '# 月曜\n集中できた', 4);
    saveReflection(db, '2026-07-09', '- todo を **消化**', 2);

    const list = listReflections(db);
    expect(list).toHaveLength(2);
    const [latest, prev] = list as [(typeof list)[number], (typeof list)[number]];
    expect(list.map((r) => r.date)).toEqual(['2026-07-09', '2026-07-07']);
    expect(latest).toMatchObject({ date: '2026-07-09', satisfaction: 2, excerpt: 'todo を 消化' });
    expect(prev.excerpt).toBe('月曜 集中できた');
    // 一覧項目に content 全文フィールドは存在しない
    expect('content' in latest).toBe(false);
  });
});
