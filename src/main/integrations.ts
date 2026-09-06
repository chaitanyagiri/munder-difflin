/**
 * 集成注册表 + 加密秘密存储（Phase 2 基础，主进程）。
 *
 * 两个职责，刻意与代理分离：
 *   1. 注册表——对 IntegrationRecord 元数据的、基于 config 的 CRUD（无秘密）。
 *   2. 秘密存储——通过 Electron `safeStorage` 在静态时加密的秘密，存放在
 *      与 config.json “分开”的文件里，只在这里、只在主进程中解密。
 *
 * 代理（src/main/integrationBroker.ts）不依赖 electron，通过注入从这里拿到
 * `getRecord` + `getSecret`，因此它在没有 electron 的情况下仍可单元测试。
 *
 * 安全：除非 `safeStorage.isEncryptionAvailable()`（关闭即失败——没有明文
 * 回退），否则绝不写入秘密；绝不移交给渲染进程、绝不记录日志、绝不放进
 * agent 的 env/transcript、绝不在任何响应中回显。记录只携带一个
 * `secretRef` 句柄。
 *
 * 契约：hive/docs/integrations-spec.md。
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type IntegrationRecord,
  validateIntegrationRecord,
  authTypeNeedsSecret,
  secretRefFor
} from '../shared/integrations';
import { readConfig, writeConfig } from './config';

// ─── 注册表（基于 config）───────────────────────────────────────────────────

/** 全部已注册的集成记录（仅元数据）。 */
export function listRecords(): IntegrationRecord[] {
  return readConfig().integrations ?? [];
}

/** 按 id 查找一条记录。 */
export function getRecord(id: string): IntegrationRecord | undefined {
  return listRecords().find((r) => r.id === id);
}

/** worker 当前可以用到的集成 id（已启用，且——对于秘密认证——确实持有
 *  已存储的秘密）。这是授予每个临时 worker 的默认能力范围。 */
export function enabledIds(): string[] {
  return listRecords()
    .filter((r) => r.enabled && (!authTypeNeedsSecret(r.authType) || hasSecret(r.secretRef)))
    .map((r) => r.id);
}

/** 创建或替换一条记录（已校验）。打上 createdAt/updatedAt 时间戳；更新时
 *  保留原始的 createdAt。不碰秘密存储。 */
export function upsertRecord(input: unknown): { ok: true; record: IntegrationRecord } | { ok: false; error: string } {
  const v = validateIntegrationRecord(input);
  if (!v.ok) return v;
  const now = Date.now();
  const existing = getRecord(v.value.id);
  const record: IntegrationRecord = {
    ...v.value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const next = listRecords().filter((r) => r.id !== record.id);
  next.push(record);
  writeConfig({ integrations: next });
  return { ok: true, record };
}

/** 移除一条记录及其存储的秘密。 */
export function removeRecord(id: string): { ok: boolean } {
  const next = listRecords().filter((r) => r.id !== id);
  writeConfig({ integrations: next });
  deleteSecret(secretRefFor(id));
  return { ok: true };
}

/** 把 secretRef 隐去为布尔值的记录——渲染进程安全的形状。 */
export function listRecordsRedacted(): Array<Omit<IntegrationRecord, 'secretRef'> & { hasSecret: boolean }> {
  return listRecords().map(({ secretRef, ...rest }) => ({ ...rest, hasSecret: !!secretRef && hasSecret(secretRef) }));
}

// ─── 秘密存储（静态加密）───────────────────────────────────────────────────

function secretsPath(): string {
  return join(app.getPath('userData'), 'integration-secrets.json');
}

function readSecretBlob(): Record<string, string> {
  const p = secretsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeSecretBlob(blob: Record<string, string>): void {
  const p = secretsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(blob, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** 以加密形式存储秘密。若 OS 加密不可用则关闭即失败（绝不写入明文）。
 *  明文只用于加密，不会保留。 */
export function setSecret(secretRef: string, plaintext: string): { ok: boolean; error?: string } {
  if (!secretRef) return { ok: false, error: 'secretRef required' };
  if (typeof plaintext !== 'string' || plaintext === '') return { ok: false, error: 'secret required' };
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secret encryption is unavailable; refusing to store a secret in plaintext' };
    }
    const cipher = safeStorage.encryptString(plaintext).toString('base64');
    const blob = readSecretBlob();
    blob[secretRef] = cipher;
    writeSecretBlob(blob);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 解密一条秘密。仅供主进程内部——绝不经 IPC 暴露。不存在或无法解密时
 *  返回 undefined（代理把它映射为 503 no_secret）。 */
export function getSecret(secretRef: string | undefined): string | undefined {
  if (!secretRef) return undefined;
  const cipher = readSecretBlob()[secretRef];
  if (!cipher) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  } catch {
    return undefined;
  }
}

/** 该 ref 是否已存储秘密（不解密）。 */
export function hasSecret(secretRef: string | undefined): boolean {
  if (!secretRef) return false;
  return !!readSecretBlob()[secretRef];
}

/** 删除已存储的秘密。幂等。 */
export function deleteSecret(secretRef: string | undefined): void {
  if (!secretRef) return;
  const blob = readSecretBlob();
  if (secretRef in blob) {
    delete blob[secretRef];
    if (Object.keys(blob).length === 0) {
      try { rmSync(secretsPath(), { force: true }); } catch { /* 尽力而为 */ }
    } else {
      writeSecretBlob(blob);
    }
  }
}
