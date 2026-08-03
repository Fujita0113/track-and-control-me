import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { findAvailablePort, resolveDbPath } from './config.js';

/**
 * spec: server-port-fallback
 * ポート探索は「使用中なら次を試す」ことを実ソケットで確認する。
 * DB パス解決は「明示指定 > フォールバックの有無」の優先順位を純粋関数として確認する。
 */

describe('findAvailablePort', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
  });

  function occupy(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      servers.push(server);
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  }

  /** 指定ポートが今この瞬間に空いているかを実ソケットで確認する（bind できれば空き）。 */
  function isFree(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
  }

  /**
   * 固定ポート番号は使わない。エフェメラルポート範囲（Windows既定 49152-65535）は
   * OS が他プロセス（IDE の内部通信等）へいつ配ってもおかしくないため、決め打ちの番号は
   * 「たまたま今日空いている」以上の保証がなく、実測でも IDE との衝突で flaky 化した。
   * 代わりに OS に port:0 で今空いている番号を教えてもらい、そこから続く count 個が
   * 全部空いていることを確認できるまで探す（見つかるまで軽く再試行する）。
   */
  async function findFreeRun(host: string, count: number): Promise<number> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const base = await new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, host, () => {
          const address = probe.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          probe.close(() => resolve(port));
        });
      });
      let allFree = true;
      for (let i = 1; i < count; i++) {
        if (!(await isFree(base + i, host))) {
          allFree = false;
          break;
        }
      }
      if (allFree) return base;
    }
    throw new Error(`空きポートの連番(${count}個)が見つかりませんでした`);
  }

  it('いつものポートが空いていればそのポートを返す', async () => {
    const freePort = await findFreeRun('127.0.0.1', 1);
    const port = await findAvailablePort(freePort, '127.0.0.1');
    expect(port).toBe(freePort);
  });

  it('いつものポートが使用中なら次の空きポートを返す', async () => {
    const base = await findFreeRun('127.0.0.1', 2);
    await occupy(base, '127.0.0.1');
    const port = await findAvailablePort(base, '127.0.0.1');
    expect(port).toBe(base + 1);
  });

  it('連続して使用中のポートはスキップする', async () => {
    const base = await findFreeRun('127.0.0.1', 3);
    await occupy(base, '127.0.0.1');
    await occupy(base + 1, '127.0.0.1');
    const port = await findAvailablePort(base, '127.0.0.1');
    expect(port).toBe(base + 2);
  });

  it('探索範囲内が全て使用中なら例外を投げる', async () => {
    const base = await findFreeRun('127.0.0.1', 3);
    for (let i = 0; i < 3; i++) {
      await occupy(base + i, '127.0.0.1');
    }
    await expect(findAvailablePort(base, '127.0.0.1', 3)).rejects.toThrow();
  });
});

describe('resolveDbPath', () => {
  const serverRoot = join('C:', 'repo', 'server');
  const basePort = 47653;

  it('明示的な DB_PATH があれば最優先で使う（フォールバック時でも）', () => {
    const result = resolveDbPath({
      explicitDbPath: ':memory:',
      fileDbPath: undefined,
      serverRoot,
      basePort,
      actualPort: basePort + 1,
    });
    expect(result).toBe(':memory:');
  });

  it('config.local.json の dbPath があればそれを使う', () => {
    const result = resolveDbPath({
      explicitDbPath: undefined,
      fileDbPath: '/custom/path.sqlite',
      serverRoot,
      basePort,
      actualPort: basePort,
    });
    expect(result).toBe('/custom/path.sqlite');
  });

  it('明示指定が無く、いつものポートで起動できた場合は実DBを使う', () => {
    const result = resolveDbPath({
      explicitDbPath: undefined,
      fileDbPath: undefined,
      serverRoot,
      basePort,
      actualPort: basePort,
    });
    expect(result).toBe(join(serverRoot, 'data', 'track.sqlite'));
  });

  it('明示指定が無く、フォールバックポートで起動した場合は開発用DBを使う', () => {
    const result = resolveDbPath({
      explicitDbPath: undefined,
      fileDbPath: undefined,
      serverRoot,
      basePort,
      actualPort: basePort + 1,
    });
    expect(result).toBe(join(serverRoot, 'data', 'track.dev.sqlite'));
  });
});
