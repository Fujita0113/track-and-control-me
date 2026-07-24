import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { isVersionBelow, isExtensionOutdated, MIN_EXTENSION_VERSION } from './ext-version.js';

describe('isVersionBelow', () => {
  it('パッチ・マイナー・メジャーの各桁を数値比較する', () => {
    expect(isVersionBelow('0.1.0', '0.2.0')).toBe(true);
    expect(isVersionBelow('0.2.0', '0.2.0')).toBe(false);
    expect(isVersionBelow('0.2.1', '0.2.0')).toBe(false);
    expect(isVersionBelow('1.0.0', '0.9.9')).toBe(false);
  });
});

function seedSample(db: DB, extVersion: string): void {
  db.prepare(
    `INSERT INTO raw_sample
      (boot_id, seq, client_ts, monotonic_ms, tz, event_type, active_group_id, window_id,
       idle_state, browser_focused, ext_version, received_at)
     VALUES ('b', 1, 0, 0, 'Asia/Tokyo', 'HEARTBEAT', -1, -1, 'active', 1, ?, 0)`,
  ).run(extVersion);
}

describe('isExtensionOutdated', () => {
  it('未受信（サンプル無し）は false', () => {
    const db = openDb(':memory:');
    expect(isExtensionOutdated(db)).toBe(false);
  });

  it('最小要求版未満のサンプルを受信していれば true', () => {
    const db = openDb(':memory:');
    seedSample(db, '0.1.0');
    expect(isExtensionOutdated(db)).toBe(true);
  });

  it('最小要求版以上なら false', () => {
    const db = openDb(':memory:');
    seedSample(db, MIN_EXTENSION_VERSION);
    expect(isExtensionOutdated(db)).toBe(false);
  });
});
