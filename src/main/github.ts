import { spawn } from 'node:child_process';

/** A GitHub issue, normalized for the renderer (labels/assignees flattened to names). */
export interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** Shape `gh issue list --json` emits for each issue (the fields we ask for). */
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
 * List up to 30 issues in the repo at `cwd` via the `gh` CLI.
 *
 * Returns `{ ok: false, error }` on any failure — spawn error (e.g. `gh` not
 * installed), non-zero exit (e.g. unauthenticated / not a repo), or a JSON
 * parse failure — so callers never have to try/catch.
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
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, 15000);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
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

/** A CI (GitHub Actions) workflow run, normalized for the renderer. */
export interface CIRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

/** Shape `gh run list --json` emits for each run (the fields we ask for). */
interface RawCIRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
  databaseId?: number;
}

/**
 * List up to 5 recent CI (GitHub Actions) workflow runs in the repo at `cwd`
 * via the `gh` CLI.
 *
 * Returns `{ ok: false, error }` on any failure — spawn error (e.g. `gh` not
 * installed), non-zero exit (e.g. unauthenticated / not a repo / no Actions),
 * or a JSON parse failure — so callers never have to try/catch.
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
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, 15000);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
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
