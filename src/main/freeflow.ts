/**
 * Free Flow —— Groq Whisper 语音转文字，在 Electron 主进程中运行。
 *
 * 渲染进程采集麦克风音频（getUserMedia → MediaRecorder），通过 IPC 把原始
 * 字节交到这里；本模块向 Groq 的 OpenAI 兼容转录端点做 multipart 上传并返回
 * 转录文本。在主进程做这个 HTTP 调用（与 `slack.ts` / `webhook.ts` 相同），
 * 用户的 Groq key 就不会进渲染进程，也避开了 CORS。
 *
 * Electron 32 内置 Node 20，因此这里的全局 `fetch` + `FormData` + `Blob`
 * （undici）都可用——无需额外依赖，也无需手写 multipart。
 *
 * API key 由调用方传入（它存放在主进程的 config 中），仅用于
 * Authorization 头，绝不记录日志。
 *
 * 刻意不 import 任何 `electron`，因此它可以作为普通 Node 模块做
 * 单元/冒烟测试。
 */

/** Groq 的 OpenAI 兼容转录端点。 */
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
/** 默认模型——快速、多语言；约 216 倍实时。另一个选项是
 *  更高精度的 `whisper-large-v3`。 */
export const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
/** Groq 免费层上传上限是 25 MB；在浪费一次网络往返之前先拒绝更大的
 *  负载（我们的片段实际只有几秒长 / 几十 KB）。 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** 别让挂起的请求卡死该功能——给调用设上限。 */
const REQUEST_TIMEOUT_MS = 60_000;

export interface TranscribeOptions {
  /** 用户的 Groq API key。仅用于 Authorization 头；绝不记录日志。 */
  apiKey: string;
  /** 渲染进程捕获的原始音频字节（例如 webm/opus）。 */
  audio: ArrayBuffer | Uint8Array | Buffer;
  /** `audio` 的 MIME 类型（例如 'audio/webm'）。默认为 'audio/webm'。 */
  mimeType?: string;
  /** 上传文件名（Groq 从扩展名推断格式）。默认为一个 webm 名称。 */
  filename?: string;
  /** Groq 模型 id。默认为 DEFAULT_GROQ_MODEL。 */
  model?: string;
  /** 可选的 ISO-639-1 语言提示，用于提升准确率/延迟。 */
  language?: string;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * 通过 Groq Whisper 转录单个音频片段。成功时 resolve `{ ok, text }`，
 * 否则 resolve `{ ok: false, error }`。从不抛错；从不记录 key。
 */
export async function transcribeWithGroq(opts: TranscribeOptions): Promise<TranscribeResult> {
  if (!opts.apiKey) return { ok: false, error: 'missing Groq API key' };

  const bytes = toUint8Array(opts.audio);
  if (bytes.byteLength === 0) return { ok: false, error: 'empty audio' };
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return { ok: false, error: 'audio too large (Groq free-tier cap is 25 MB)' };
  }

  const mimeType = opts.mimeType || 'audio/webm';
  const filename = opts.filename || 'dictation.webm';
  const model = opts.model || DEFAULT_GROQ_MODEL;

  const form = new FormData();
  form.append('model', model);
  // `response_format=text` 返回裸转录文本，但 JSON 更稳健——
  // 我们请求 json，并用防御性的方式读取 `.text`。
  form.append('response_format', 'json');
  if (opts.language) form.append('language', opts.language);
  form.append('file', new Blob([toArrayBuffer(bytes)], { type: mimeType }), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: controller.signal
    });
    const raw = await res.text();
    if (!res.ok) {
      // 透出 Groq 的错误信息（不是 key）——例如 401 invalid_api_key、
      // 413 太大、429 被限流。保持简短。
      return { ok: false, error: `Groq ${res.status}: ${extractError(raw) || res.statusText}` };
    }
    let text = '';
    try {
      const json = JSON.parse(raw) as { text?: unknown };
      text = typeof json.text === 'string' ? json.text.trim() : '';
    } catch {
      // response_format 回退：纯文本响应体。
      text = raw.trim();
    }
    if (!text) return { ok: false, error: 'no speech detected' };
    return { ok: true, text };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, error: aborted ? 'transcription timed out' : errMsg(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 若存在，从 Groq 的 JSON 错误信封中取出可读的消息。 */
function extractError(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string };
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
  } catch { /* 不是 json */ }
  return '';
}

function toUint8Array(audio: ArrayBuffer | Uint8Array | Buffer): Uint8Array {
  if (audio instanceof Uint8Array) return audio; // Buffer 是 Uint8Array 的子类
  return new Uint8Array(audio);
}

/** Blob 需要 ArrayBuffer 支撑的视图；拷贝出一份干净的 ArrayBuffer 切片。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
