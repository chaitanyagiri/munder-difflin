/**
 * 通过 https 抓取文本的唯一入口。
 *
 * 当 hero 负载也需要同样的能力时，从 skills.ts 中拆出：重定向跟随、超时和
 * 状态处理若存在两份拷贝就会逐渐分叉，而分叉的那份往往是没人盯着的那份。
 *
 * 只走 https，这是刻意为之——所有调用方都从 raw.githubusercontent 或仓库
 * URL 抓取，如果回退到 http: 会悄悄降级应用随后渲染的内容。
 */
import { request as httpsRequest } from 'node:https';

export function getText(url: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers: { 'user-agent': 'munder-difflin' } }, (res) => {
      // 每一跳跟随一次重定向；raw.githubusercontent 对
      // 分支别名需要这样，缺少它会直接请求失败。
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getText(res.headers.location, opts).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.end();
  });
}
