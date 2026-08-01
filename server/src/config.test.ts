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

  it('いつものポートが空いていればそのポートを返す', async () => {
    const port = await findAvailablePort(58001, '127.0.0.1');
    expect(port).toBe(58001);
  });

  it('いつものポートが使用中なら次の空きポートを返す', async () => {
    await occupy(58011, '127.0.0.1');
    const port = await findAvailablePort(58011, '127.0.0.1');
    expect(port).toBe(58012);
  });

  it('連続して使用中のポートはスキップする', async () => {
    await occupy(58021, '127.0.0.1');
    await occupy(58022, '127.0.0.1');
    const port = await findAvailablePort(58021, '127.0.0.1');
    expect(port).toBe(58023);
  });

  it('探索範囲内が全て使用中なら例外を投げる', async () => {
    const base = 58030;
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
