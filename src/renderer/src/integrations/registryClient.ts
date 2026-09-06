// 集成注册表客户端 —— 渲染器的集成注册表 + 密钥代理的唯一入口。
//
// 遵循 Jim 的 spec v1（hive/docs/integrations-spec.md）：类型来自
// `@shared/integrations`（Jim 的 src/shared/integrations.ts）的规范定义，
// 客户端与 §6 IPC 接口 1:1 映射 —— 其处理器已存在于
// src/main/index.ts（integrations:list / templates / upsert / setSecret / remove /
// test）。真实路径调用 window.cth.*（Jim 的 preload bridge）。
//
// ⚠️ preload bridge 尚未落地（Jim 负责 —— god 会在落地后通知）。
// 在此之前回退到内存 mock，使 UI 在 dev 下完全可用。
// 真实路径是 FEATURE-DETECTED 的：Jim 的 preload 方法出现的瞬间即激活，
// 此处无需改动。两个协调要点：
//   1. 下面的桥接方法名称（integrationsList、…）遵循现有
//      preload camelCase→冒号通道约定（getConfig→'config:get' 等）。
//      Jim：暴露这些（或告诉我名称）以便检测匹配。
//   2. `integrations:templates` 提供的是 Jim 的 `INTEGRATION_TEMPLATES`
//      （2 个 v1 参考模板）。Dwight 的 src/shared/integrationTemplates.ts
//      是独立的、尚未接线的文件 —— 协调是 god/Jim/Dwight 的工作。
//
// 安全不变式（匹配 §2）：密钥值单向流动 —— 从表单
// 进入 save() 的 setSecret 调用并继续到加密存储。绝不回读。
// list() 返回的记录中 secretRef 被脱敏为 hasSecret:boolean。

import {
  INTEGRATION_TEMPLATES,
  authTypeNeedsSecret,
  secretRefFor,
  validateIntegrationRecord,
  type IntegrationRecord,
  type IntegrationTemplate
} from '@shared/integrations';

export type { IntegrationRecord, IntegrationTemplate } from '@shared/integrations';
export type { IntegrationKind, IntegrationAuthType } from '@shared/integrations';

/** 渲染器可见的记录：secretRef 被脱敏为存在性布尔值。
 *  匹配 main 侧的 `integrations.listRecordsRedacted()`。 */
export type IntegrationRecordView = Omit<IntegrationRecord, 'secretRef'> & { hasSecret: boolean };

/** §6 `integrations:test` 探测的结果。 */
export interface TestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

type UpsertResult = { ok: true; record: IntegrationRecord } | { ok: false; error: string };

export interface IntegrationsClient {
  listTemplates(): Promise<IntegrationTemplate[]>;
  list(): Promise<IntegrationRecordView[]>;
  /** §6 upsert（元数据，无密钥）+ §6 setSecret（当用户输入了新密钥时）。 */
  save(record: IntegrationRecord, secret?: string): Promise<{ ok: boolean; error?: string }>;
  remove(id: string): Promise<{ ok: boolean }>;
  test(id: string): Promise<TestResult>;
}

// Jim 暴露的 preload bridge（Deliverable 2）。通道由 §6 固定；
// 通过宽容类型转换来访问，以便 bridge 不存在时也能编译。
interface IntegrationsBridge {
  integrationsList(): Promise<IntegrationRecordView[]>;
  integrationsTemplates(): Promise<IntegrationTemplate[]>;
  integrationsUpsert(record: IntegrationRecord): Promise<UpsertResult>;
  integrationsSetSecret(req: { id: string; secret: string }): Promise<{ ok: boolean; error?: string }>;
  integrationsRemove(req: { id: string }): Promise<{ ok: boolean }>;
  integrationsTest(req: { id: string; path?: string }): Promise<TestResult>;
}

function liveBridge(): IntegrationsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { cth?: Partial<IntegrationsBridge> }).cth;
  return b && typeof b.integrationsList === 'function' ? (b as IntegrationsBridge) : undefined;
}

// ───────────────────────── 临时 mock（仅 dev 回退）────────────────────────
// 提供 Jim 的规范 INTEGRATION_TEMPLATES 并用 Jim 的真实
// validateIntegrationRecord 验证 upsert，使 mock 行为与有线后端一致。

let mockRecords: IntegrationRecord[] = [];
const mockSecret = new Set<string>(); // 仅 secretRef 成员 —— 不含实际值

function redact(r: IntegrationRecord): IntegrationRecordView {
  const { secretRef, ...rest } = r;
  return { ...rest, hasSecret: !!secretRef && mockSecret.has(secretRef) };
}

const mockClient: IntegrationsClient = {
  listTemplates: () => Promise.resolve(INTEGRATION_TEMPLATES.map((t) => ({ ...t }))),
  list: () => Promise.resolve(mockRecords.map(redact)),
  save: (record, secret) => {
    const v = validateIntegrationRecord(record);
    if (!v.ok) return Promise.resolve({ ok: false, error: v.error });
    const now = Date.now();
    const prev = mockRecords.find((r) => r.id === v.value.id);
    const full: IntegrationRecord = { ...v.value, createdAt: prev?.createdAt ?? now, updatedAt: now };
    if (prev) mockRecords = mockRecords.map((r) => (r.id === full.id ? full : r));
    else mockRecords.push(full);
    if (secret && secret.length > 0 && full.secretRef) mockSecret.add(full.secretRef);
    return Promise.resolve({ ok: true });
  },
  remove: (id) => {
    const r = mockRecords.find((x) => x.id === id);
    if (r?.secretRef) mockSecret.delete(r.secretRef);
    mockRecords = mockRecords.filter((x) => x.id !== id);
    return Promise.resolve({ ok: true });
  },
  test: (id) => {
    const r = mockRecords.find((x) => x.id === id);
    if (!r) return Promise.resolve({ ok: false, error: '未知集成' });
    if (!r.enabled) return Promise.resolve({ ok: false, error: '集成已禁用' });
    if (authTypeNeedsSecret(r.authType) && !(r.secretRef && mockSecret.has(r.secretRef))) {
      return Promise.resolve({ ok: false, status: 503, error: '未设置密钥' });
    }
    return Promise.resolve({ ok: true, status: 200 });
  }
};

// ───────────────────────── 导出的客户端（真实 → mock 回退）────────────────────────

export const integrationsClient: IntegrationsClient = {
  listTemplates: () => {
    const b = liveBridge();
    return b ? b.integrationsTemplates() : mockClient.listTemplates();
  },
  list: () => {
    const b = liveBridge();
    return b ? b.integrationsList() : mockClient.list();
  },
  save: async (record, secret) => {
    const b = liveBridge();
    if (!b) return mockClient.save(record, secret);
    const up = await b.integrationsUpsert(record);
    if (!up.ok) return { ok: false, error: up.error };
    if (secret && secret.length > 0) {
      const ss = await b.integrationsSetSecret({ id: record.id, secret });
      if (!ss.ok) return { ok: false, error: ss.error };
    }
    return { ok: true };
  },
  remove: (id) => {
    const b = liveBridge();
    return b ? b.integrationsRemove({ id }) : mockClient.remove(id);
  },
  test: (id) => {
    const b = liveBridge();
    return b ? b.integrationsTest({ id }) : mockClient.test(id);
  }
};

// ───────────────────────── 小型 UI 辅助函数 ─────────────────────────

/** 从标签生成 slug（服务端 validateIntegrationRecord 为准）。 */
export function slugify(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return base.length >= 2 ? base : `${base || 'api'}-x`;
}
