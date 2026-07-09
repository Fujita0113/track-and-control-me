import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * パスワード生成コマンドの実行（design.md D8 / task 5.1）。
 * command_template の {date} を対象日で埋め、pwsh 等を timeout 付き execFile で実行、
 * stdout をパスワード候補とする。内部実装は持たず、差し替え可能なコマンドに委譲。
 */

const here = dirname(fileURLToPath(import.meta.url)); // server/src/password
export const REPO_ROOT = resolve(here, '..', '..', '..'); // repo ルート

export interface PasswordCommandConfigRow {
  id: number;
  command_template: string;
  working_dir: string | null;
  timeout_seconds: number;
  version: number;
  is_active: number;
  created_at: number;
}

export interface CommandResult {
  ok: boolean;
  password: string | null;
  exitCode: number | null;
  error?: string;
}

/** 単純な空白区切りトークナイズ（引用符・スペース入りパスは working_dir で回避）。 */
function tokenize(template: string, dateStr: string): string[] {
  return template
    .replace(/\{date\}/g, dateStr)
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function runPasswordCommand(
  cfg: Pick<PasswordCommandConfigRow, 'command_template' | 'working_dir' | 'timeout_seconds'>,
  dateStr: string,
): Promise<CommandResult> {
  const tokens = tokenize(cfg.command_template, dateStr);
  const file = tokens[0];
  const args = tokens.slice(1);
  const cwd = cfg.working_dir ?? REPO_ROOT;
  const timeoutMs = Math.max(1, cfg.timeout_seconds) * 1000;

  if (!file) {
    return Promise.resolve({ ok: false, password: null, exitCode: null, error: 'empty command' });
  }

  return new Promise<CommandResult>((resolvePromise) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          const code = typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : null;
          resolvePromise({
            ok: false,
            password: null,
            exitCode: code,
            error: killed ? `timeout (${cfg.timeout_seconds}s)` : (stderr || err.message).trim(),
          });
          return;
        }
        const password = String(stdout).trim();
        if (password.length === 0) {
          resolvePromise({ ok: false, password: null, exitCode: 0, error: 'empty output' });
          return;
        }
        resolvePromise({ ok: true, password, exitCode: 0 });
      },
    );
  });
}
