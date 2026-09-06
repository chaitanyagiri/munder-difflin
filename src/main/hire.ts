/**
 * 主进程的 hire-manifest 传输：从 https URL（深链接）抓取清单，或从磁盘
 * 读取（文件导入），并通过共享的、零依赖的校验器验证。规格与安全模型见
 * `src/shared/hire.ts`。刻意不 import 任何 `electron`，因此可以当作普通
 * Node 模块做冒烟测试（与 webhook.ts 的做法一致）。
 */
import { readFileSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { basename } from 'node:path';
import {
  HIRE_MAX_BYTES,
  isAllowedManifestUrl,
  validateHireManifest,
  type HireManifest,
  type HireValidation
} from '../shared/hire';

export type HireResult = { ok: true; manifest: HireManifest } | { ok: false; error: string };

function finish(v: HireValidation): HireResult {
  if (v.ok && v.manifest) return { ok: true, manifest: v.manifest };
  return { ok: false, error: `无效的 hire manifest：${v.errors.join('; ')}` };
}

/** 我们绝不允许抓取的地址范围（SSRF 守卫）：回环、RFC1918 私网、链路本地
 *  （含 169.254.169.254 云元数据端点）、CGNAT、ULA、已废弃的 site-local，
 *  以及未指定/组播/保留地址。仅 https 并不能让目标安全——远程清单可以
 *  指向/重定向到 https://10.x 或 https://169.254.169.254，因此被把关的是
 *  解析后的“地址”。node:net 的 BlockList 做真正的前缀归属判断（子网运算），
 *  取代了早先手写的 v6 字符串前缀逻辑——那种 v4 映射的十六进制形式
 *  （例如 ::ffff:7f00:1，正是 `new URL()` 实际输出的形状）能直接溜过去。
 *  下面的检查会把 v4-in-v6 形式先行解映射为内嵌的 v4。 */
const SSRF_BLOCK = new BlockList();
// IPv4 范围。
SSRF_BLOCK.addSubnet('0.0.0.0', 8, 'ipv4');        // 0.0.0.0/8 “本网络”/ 未指定
SSRF_BLOCK.addSubnet('10.0.0.0', 8, 'ipv4');       // RFC1918
SSRF_BLOCK.addSubnet('100.64.0.0', 10, 'ipv4');    // CGNAT
SSRF_BLOCK.addSubnet('127.0.0.0', 8, 'ipv4');      // 回环
SSRF_BLOCK.addSubnet('169.254.0.0', 16, 'ipv4');   // 链路本地 + 169.254.169.254 云元数据
SSRF_BLOCK.addSubnet('172.16.0.0', 12, 'ipv4');    // RFC1918
SSRF_BLOCK.addSubnet('192.168.0.0', 16, 'ipv4');   // RFC1918
SSRF_BLOCK.addSubnet('224.0.0.0', 3, 'ipv4');      // 224/4 组播 + 240/4 保留 + 广播
// IPv6 范围。
SSRF_BLOCK.addAddress('::1', 'ipv6');              // 回环
SSRF_BLOCK.addAddress('::', 'ipv6');               // 未指定
SSRF_BLOCK.addSubnet('fc00::', 7, 'ipv6');         // ULA（fc00::/7）
SSRF_BLOCK.addSubnet('fe80::', 10, 'ipv6');        // 链路本地（fe80::/10）
SSRF_BLOCK.addSubnet('fec0::', 10, 'ipv6');        // 已废弃的 site-local（fec0::/10）
SSRF_BLOCK.addSubnet('ff00::', 8, 'ipv6');         // 组播（ff00::/8）

/** 把 IPv6 字面量展开成八个 16 位组，处理 `::` 压缩和尾部内嵌的点分四段。
 *  格式错误时返回 null（→ 关闭即失败）。 */
function v6Groups(v6: string): number[] | null {
  let s = v6;
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // 丢弃任何 zone id
  // 尾部的点分四段（例如 ::ffff:127.0.0.1）变成两个十六进制组。
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ':' + lo;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (back === null) {
    groups = head; // 没有 `::`
  } else {
    const missing = 8 - head.length - back.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...back];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

/** 若 v6 字面量内嵌了一个 IPv4 目的地——v4 映射的 `::ffff:a.b.c.d`（点分和
 *  十六进制组两种形式都算）、已废弃的 v4 兼容 `::a.b.c.d`、NAT64
 *  `64:ff9b::/96`、或 6to4 `2002::/16`——返回那个点分 v4，让 v4 分类器
 *  把关。这些都路由到 v4 目的地，而十六进制组形式正是绕过旧文本 v6 检查
 *  的元凶。否则返回 null。 */
function embeddedV4(v6: string): string | null {
  const g = v6Groups(v6);
  if (!g) return null;
  const v4 = (hi: number, lo: number): string => `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  const top6zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (top6zero && g[5] === 0xffff) return v4(g[6], g[7]);                            // ::ffff:a.b.c.d（v4 映射）
  if (top6zero && g[5] === 0 && (g[6] !== 0 || g[7] !== 0)) return v4(g[6], g[7]);   // ::a.b.c.d / ::1（v4 兼容）
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4(g[6], g[7]); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return v4(g[1], g[2]);                                        // 6to4 2002::/16
  return null;
}

/** 当 IP 字面量落入被封禁的范围时返回 true。v4-in-v6 形式先解映射为内嵌的
 *  v4；任何无法解析为 IP 的内容都按“关闭即失败”处理（返回 true）。 */
function isBlockedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  const kind = isIP(addr);
  if (kind === 4) return SSRF_BLOCK.check(addr, 'ipv4');
  if (kind === 6) {
    const v4 = embeddedV4(addr);
    if (v4 && isIP(v4) === 4) return SSRF_BLOCK.check(v4, 'ipv4');
    return SSRF_BLOCK.check(addr, 'ipv6');
  }
  return true; // 不是可解析的 IP 字面量 → 关闭即失败
}

/** 解析主机（或直接用字面量 IP），若“任一”解析出的地址在封禁范围内则返回
 *  true。无法解析 → 视为封禁（关闭即失败）。堵住简单的 DNS 转内部 SSRF；
 *  本查找与 fetch() 自身解析之间被蓄意 rebind 的攻击，是 v1 接受下来的
 *  残余风险（不做连接钉扎）。 */
async function isInternalHost(hostname: string): Promise<boolean> {
  const host = hostname.replace('[', '').replace(']', ''); // 去掉 IPv6 括号
  if (isIP(host)) return isBlockedIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address));
  } catch { return true; }
}

/** 对“单个”url 的 SSRF 门——初始请求以及每一跳重定向都要过。唯一允许的
 *  内部目标是文档化的 http-loopback 开发画廊（已由 isAllowedManifestUrl
 *  把关）；其余每个目标都必须解析到公网地址。目标为内部时返回错误字符串，
 *  否则返回 null。 */
async function assertPublicTarget(u: URL): Promise<string | null> {
  const devLoopbackHttp = u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  if (devLoopbackHttp) return null;
  if (await isInternalHost(u.hostname)) {
    return 'manifest 地址解析到私网/回环/链路本地地址（已阻止 SSRF）';
  }
  return null;
}

/** 从 https URL 抓取 + 校验 hire 清单。有边界：10 秒超时、64 KB 响应体
 *  上限、仅 https（深链接解析器已经强制 https，但这里也会被用户粘贴的
 *  URL 调用）。 */
export async function fetchHireManifest(src: string): Promise<HireResult> {
  let url: URL;
  try { url = new URL(src); } catch { return { ok: false, error: '不是有效的 URL' }; }
  if (!isAllowedManifestUrl(url)) return { ok: false, error: 'manifest 地址必须是 https（仅 localhost 允许 http）' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // redirect:'manual' —— `follow` 只会校验“初始”url，因此远程 https 清单
    // 可以 302 到 http://127.0.0.1:PORT/... 或云元数据端点，把一次点击变成
    // 对内部服务的盲目 GET。我们自行跟随每一跳，并重新校验每个 Location。
    //   - 初始 url 可以是 http-loopback（本地画廊开发时经 http://localhost
    //     提供服务）——isAllowedManifestUrl 允许它；
    //   - 重定向目标必须是 https。真正的画廊绝不需要把你弹到回环/内部 http，
    //     要求每跳 https 能直接堵死基于重定向的 SSRF（127.0.0.1:PORT 和
    //     链路本地/元数据 IP），同时 https→https 重定向（短链、CDN）仍然可用。
    //   - 并且每个目标（初始 + 每一跳）解析出的“地址”必须是公网：
    //     https://10.x / https://169.254.169.254 否则就能溜过仅-https 检查。
    //     assertPublicTarget 解析 DNS 并封禁私网/回环/链路本地/元数据 IP。
    const ssrf0 = await assertPublicTarget(url);
    if (ssrf0) return { ok: false, error: ssrf0 };
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { accept: 'application/json' }
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, error: '重定向缺少 location' };
        let next: URL;
        try { next = new URL(loc, current); } catch { return { ok: false, error: '无效的重定向目标' }; }
        if (next.protocol !== 'https:') return { ok: false, error: '重定向目标必须是 https（manifest 不得重定向进 http/回环）' };
        const ssrfN = await assertPublicTarget(next);
        if (ssrfN) return { ok: false, error: ssrfN };
        current = next;
        continue;
      }
      break;
    }
    if (!res) return { ok: false, error: '抓取失败' };
    if (res.status >= 300 && res.status < 400) return { ok: false, error: '重定向次数过多' };
    if (!res.ok) return { ok: false, error: `抓取失败：HTTP ${res.status}` };

    // 边读边限制响应体——content-length 是攻击者可控制的（缺失/分块会跳过
    // 检查），而 `res.text()` 会先把整个流缓冲起来，因此恶意主机可以在 10 秒
    // 窗口内无限流式放数据，把我们 OOM 掉。按块读取，字节数一超上限就中止。
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > HIRE_MAX_BYTES) return { ok: false, error: 'manifest 过大' };
    const text = await readBounded(res, HIRE_MAX_BYTES);
    if (text === null) return { ok: false, error: 'manifest 过大' };

    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'manifest 不是有效的 JSON' }; }
    return finish(validateHireManifest(parsed));
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? '抓取超时' : String(e);
    return { ok: false, error: `抓取失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 读取响应体，按 UTF-8 解码，字节数超过 `maxBytes` 即中止。超限返回 null。
 *  按字节精确计算（上限是字节数，不是 UTF-16 码元）。 */
async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  const body = res.body;
  if (!body) {
    // 没有流（例如某些 fetch polyfill）——回退到 text() 并事后检查。
    const t = await res.text();
    return Buffer.byteLength(t, 'utf8') > maxBytes ? null : t;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* 空操作 */ } return null; }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 从本地 JSON 文件读取 + 校验 hire 清单（文件导入）。 */
export function readHireManifestFile(path: string): HireResult {
  try {
    if (statSync(path).size > HIRE_MAX_BYTES) return { ok: false, error: 'manifest 过大' };
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return finish(validateHireManifest(parsed));
  } catch (e) {
    return { ok: false, error: `无法读取 manifest：${String(e)}` };
  }
}

/** 独立校验文件选择器的一次批量选择：一份坏清单绝不会连带丢弃与它一起
 * 选中的有效清单。错误只点名文件名，不给出完整本地路径，这样渲染进程
 * 能解释跳过了什么，又不会把用户的目录结构泄漏进日志或截图。 */
export function readHireManifestFiles(paths: readonly string[]): {
  manifests: HireManifest[];
  errors: string[];
} {
  const manifests: HireManifest[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    const result = readHireManifestFile(path);
    if (result.ok) manifests.push(result.manifest);
    else {
      const name = basename(path);
      errors.push(`${name}: ${result.error.split(path).join(name)}`);
    }
  }
  return { manifests, errors };
}
