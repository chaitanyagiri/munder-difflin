import { spawn } from 'node:child_process';

/** 一个 GitHub issue，为渲染进程归一化（labels/assignees 铺平为名字）。 */
export interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** `gh issue list --json` 为每个 issue 输出的形状（即我们要求的字段）。 */
interface RawGHIssue {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  state?: string;
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
}

/**
 * 通过 `gh` CLI 列出 `cwd` 仓库中最多 30 个 issue。
 *
 * 任何失败都返回 `{ ok: false, error }`——spawn 错误（例如未安装 `gh`）、
 * 非零退出（例如未认证 / 不是仓库）、或 JSON 解析失败——
 * 因此调用方永远不需要 try/catch。
 */
export function listIssues(cwd: string): Promise<{ ok: boolean; issues?: GHIssue[]; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'gh',
      ['issue', 'list', '--json', 'number,title,body,assignees,labels,url,state', '--limit', '30'],
      { cwd }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `gh exited ${code}` });
        return;
      }
      try {
        const raw = JSON.parse(stdout) as RawGHIssue[];
        const issues: GHIssue[] = (Array.isArray(raw) ? raw : []).map((i) => ({
          number: i.number ?? 0,
          title: i.title ?? '',
          body: i.body ?? '',
          url: i.url ?? '',
          labels: (i.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
          assignees: (i.assignees ?? []).map((a) => a.login ?? '').filter(Boolean)
        }));
        resolve({ ok: true, issues });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}

/** 一次 CI（GitHub Actions）工作流运行，为渲染进程归一化。 */
export interface CIRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

/** `gh run list --json` 为每次运行输出的形状（即我们要求的字段）。 */
interface RawCIRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
  databaseId?: number;
}

/**
 * 通过 `gh` CLI 列出 `cwd` 仓库中最多 5 条最近的 CI（GitHub Actions）
 * 工作流运行。
 *
 * 任何失败都返回 `{ ok: false, error }`——spawn 错误（例如未安装 `gh`）、
 * 非零退出（例如未认证 / 不是仓库 / 没有 Actions）、或 JSON 解析失败——
 * 因此调用方永远不需要 try/catch。
 */
export function listCIRuns(cwd: string): Promise<{ ok: boolean; runs?: CIRun[]; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'gh',
      ['run', 'list', '--limit', '5', '--json', 'name,status,conclusion,url,databaseId'],
      { cwd }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `gh exited ${code}` });
        return;
      }
      try {
        const raw = JSON.parse(stdout) as RawCIRun[];
        const runs: CIRun[] = (Array.isArray(raw) ? raw : []).map((r) => ({
          name: r.name ?? '',
          status: r.status ?? '',
          conclusion: r.conclusion ?? null,
          url: r.url ?? ''
        }));
        resolve({ ok: true, runs });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}
