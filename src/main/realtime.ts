/**
 * Realtime Michael —— 主进程的临时令牌铸造（卡片 rt-1，第一阶段）。
 *
 * 语音编排器（OpenAI `gpt-realtime-2`，基于 WebRTC 的语音到语音）从
 * 渲染进程连接。渲染进程绝不能持有真实的 OpenAI key，所以由 MAIN 持有：
 * BYOK key 加密静态存储在 `integration-secrets.json` 的 `apikey:openai`
 * 下（就是 CLI 引擎用的那个只写 broker——通过 `providerKey:*` IPC 设置，
 * 仅主进程可见，从不回显）。按需时 MAIN 仅解密一次，铸造一个
 * 短期有效的临时客户端密钥；只有那个 token + 一份最小会话配置跨 IPC
 * 传给渲染进程的 `RealtimeSession`。真实 key 从不经 IPC 返回、从不记录。
 *
 * 第一阶段只读——本模块只铸造（没有动作工具；那是 rt-5）。
 *
 * 分支 feat/realtime-michael。见 board.md “🎙 REALTIME MICHAEL”。
 */
import { ipcMain } from 'electron';
import { getSecret, hasSecret } from './integrations';

/** 镜像 src/main/index.ts 中的 `providerKeyRef('openai')`（BACKEND_KEY_ENV 把
 *  openai→OPENAI_API_KEY）。内联成局部常量，让本模块无需给 index.ts 增加新
 *  导出——把 index.ts 的改动保持在单行注册上（rt-1 COORD：Oscar 也改
 *  index.ts）。 */
const OPENAI_KEY_REF = 'apikey:openai';

/** 语音编排器用的 GA 语音到语音模型（v0.3.4：升到 2026 年 7 月的
 *  gpt-realtime-2.1——p95 延迟降 25%，打断处理更好）。定义在 shared/
 *  并在这里再导出：Settings 会在用户能读到的文案里指名这个模型，
 *  所以主进程和 UI 不能对它有分歧。 */
export { REALTIME_MODEL } from '../shared/realtimePricing';
import { REALTIME_MODEL } from '../shared/realtimePricing';

/** GA 临时密钥铸造端点。如果某个账户/套餐仍按遗留 beta 形状应答，
 *  我们就在 404 时回退到 /v1/realtime/sessions，并把下面两种响应形状
 *  归一化。（真机验证要等用户的真实 key。） */
const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const LEGACY_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';

const MINT_TIMEOUT_MS = 15_000;

export type MintResult =
  | { ok: true; token: string; expiresAt: number | null; sessionConfig: { model: string } }
  | { ok: false; error: string; code?: string };

/** 是否已存储 BYOK OpenAI key（只看存在性——不解密）。作为渲染进程中
 *  Realtime Michael 语音开关的门控，就如同 `hasGroqKey` 门控 Free Flow
 *  麦克风按钮一样。 */
export function hasOpenAiKey(): boolean {
  return hasSecret(OPENAI_KEY_REF);
}

/** 为 realtime WebRTC 会话铸造一个短期有效的临时客户端密钥。真实 OpenAI
 *  key 只在这里于 MAIN 侧解密，而且绝不是结果的一部分。 */
export async function mintRealtimeToken(model: string = REALTIME_MODEL): Promise<MintResult> {
  const key = getSecret(OPENAI_KEY_REF);
  if (!key) {
    return { ok: false, error: 'no OpenAI API key set — add one in Settings → Voice', code: 'no_key' };
  }

  const post = async (url: string, body: unknown) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MINT_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      const text = await r.text();
      let json: Record<string, unknown> | undefined;
      try { json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined; } catch { /* 非 JSON 响应体 */ }
      return { status: r.status, ok: r.ok, json, text };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // 先试 GA 形状：{ session: { type, model } } → { value, expires_at, ... }。
    let res = await post(CLIENT_SECRETS_URL, { session: { type: 'realtime', model } });
    // 老账户：回退到遗留 sessions 端点形状。
    if (res.status === 404) res = await post(LEGACY_SESSIONS_URL, { model });

    if (!res.ok) {
      const errObj = res.json?.error as { message?: unknown } | undefined;
      const msg =
        (typeof errObj?.message === 'string' && errObj.message) ||
        (res.text ? res.text.slice(0, 200) : `HTTP ${res.status}`);
      return { ok: false, error: `token mint failed (${res.status}): ${msg}`, code: 'mint_failed' };
    }

    // 在 GA ({ value }) 与遗留 ({ client_secret: { value } }) 形状间归一化。
    const clientSecret = res.json?.client_secret as { value?: unknown; expires_at?: unknown } | undefined;
    const token =
      (typeof res.json?.value === 'string' && (res.json.value as string)) ||
      (typeof clientSecret?.value === 'string' && clientSecret.value) ||
      '';
    if (!token) return { ok: false, error: 'mint returned no ephemeral token', code: 'no_token' };

    const expRaw = res.json?.expires_at ?? clientSecret?.expires_at;
    const expiresAt = typeof expRaw === 'number' ? expRaw : null;

    return { ok: true, token, expiresAt, sessionConfig: { model } };
  } catch (e) {
    const err =
      e instanceof Error ? (e.name === 'AbortError' ? 'token mint timed out' : e.message) : String(e);
    return { ok: false, error: err, code: 'network' };
  }
}

/** 注册面向渲染进程的 realtime IPC。由 index.ts 调用一次（而不是在那边逐
 *  handler 写 `ipcMain.handle`）把 index.ts 的占地保持在一行——rt-1 COORD
 *  说明（Oscar 也改 index.ts）。两个 handler 都绝不返回真实 OpenAI key。 */
export function registerRealtimeIpc(): void {
  // 仅布尔存在性——门控语音开关。
  ipcMain.handle('realtime:hasKey', () => hasOpenAiKey());
  // 铸造一个临时令牌；只返回 { token, sessionConfig }。
  ipcMain.handle('realtime:mintToken', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { model?: unknown };
    const model = typeof p.model === 'string' && p.model.trim() ? p.model.trim() : REALTIME_MODEL;
    return mintRealtimeToken(model);
  });
}
