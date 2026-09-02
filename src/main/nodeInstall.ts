/**
 * 安装 Node.js 本身，让一台什么都没有的机器也能运行 agent。
 *
 * 创始人决策（2026-08-07），取代早先“绝不自动安装系统 Node”的约束：默认
 * 情况下我们把真东西——最新稳定（LTS）版 Node + 随附的 npm——装进用户的
 * 系统。Electron 自带的 Node 只作为最后的兜底备用（见 hive.runtimeBinDir）。
 *
 * 用户必须输入密码：每个官方安装程序都会写到 home 目录之外。这发生在
 * 与本应用其他所有安装程序相同的终端里，且对用户可见——我们从不静默提权。
 *
 * 因为我们以 root 运行安装程序，所以在任何东西执行之前，下载都会对照
 * nodejs.org 自己的 SHASUMS256.txt 做校验和验证。不匹配即中止。
 *
 * 这里不 import electron：URL/产物/脚本逻辑全是纯函数，
 * 无需启动应用即可测试。
 */

/** 我们认为可用的最低 Node 主版本。低于它就提供升级；达到或高于它则完全
 *  不去动用户自己的安装——一套已有、可用的工具链绝不会被“升级”到用户
 *  脚下。选 Electron 自带的同代版本，即我们已知所有代码路径都能容忍的下限。 */
export const NODE_FLOOR_MAJOR = 20;

const DIST = 'https://nodejs.org/dist';

export interface NodeDistEntry {
  version: string;              // 'v24.19.0'
  lts: false | string;          // false | 'Krypton'
  npm?: string;
}

export interface NodeInstaller {
  version: string;              // 'v24.19.0'
  npmVersion?: string;
  file: string;                 // 'node-v24.19.0.pkg'
  url: string;
  sha256: string;
  kind: 'pkg' | 'msi' | 'tar';
}

/** `v24.19.0` / `24.19.0` 的主版本号，无法解析时为 null。 */
export function nodeMajor(version: string | null | undefined): number | null {
  const m = /^v?(\d+)\./.exec((version ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** 用户自己的 Node 是否好到可以不去动它。 */
export function nodeIsUsable(version: string | null | undefined): boolean {
  const major = nodeMajor(version);
  return major !== null && major >= NODE_FLOOR_MAJOR;
}

type VersionProbe = (nodePath: string) => string;

const execNodeVersion: VersionProbe = (nodePath) =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('node:child_process')
    .execFileSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

/** 取自用户 PATH 实际解析到的二进制（见 pty.commandPath）的 `node --version`。
 *  当 node 缺失或探测完全失败时为 null——两者都意味着“我们无法为这个运行时
 *  背书”，于是进入安装阶梯，而不是静默地假设它没问题。 */
export function detectNodeVersion(
  nodePath: string | null | undefined,
  probe: VersionProbe = execNodeVersion
): string | null {
  if (!nodePath) return null;
  try {
    const out = (probe(nodePath) || '').trim();
    return /^v?\d+\./.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** nodejs.org 的 index.json 中最新的 LTS。索引按从新到旧排列，`lts` 是
 *  代号（或 false），所以第一个真值就是最新的稳定线。
 *  我们刻意不取 index[0]——那是当前/奇数版本发布，对只想让东西跑起来的
 *  用户来说那不是“最新稳定版”的意思。 */
export function pickLatestLts(index: NodeDistEntry[]): NodeDistEntry | null {
  return index.find((e) => e && e.lts) ?? null;
}

/** 某个平台/架构的安装包产物。
 *
 *  名称在这里推导，但由调用方对照 SHASUMS256.txt 校验——index.json 的
 *  `files` 数组在这方面不可信：尽管 `node-<v>-arm64.msi` 确实发布，
 *  它却不列出 `win-arm64-msi`，而且它的 `osx-x64-pkg` 条目实际指的是
 *  单个 UNIVERSAL `node-<v>.pkg`。
 *
 *  Linux 没有官方安装包——只有 tarball——所以它用 tar 类型，解包到
 *  /usr/local。 */
export function nodeArtifactFor(
  version: string,
  platform: string,
  arch: string
): { file: string; kind: NodeInstaller['kind'] } | null {
  if (platform === 'darwin') return { file: `node-${version}.pkg`, kind: 'pkg' };
  if (platform === 'win32') {
    const a = arch === 'arm64' ? 'arm64' : 'x64';
    return { file: `node-${version}-${a}.msi`, kind: 'msi' };
  }
  if (platform === 'linux') {
    const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
    if (!a) return null;
    return { file: `node-${version}-linux-${a}.tar.xz`, kind: 'tar' };
  }
  return null;
}

/** 从 SHASUMS256.txt 正文（"<sha>  <file>" 行）中取出某个文件的摘要。 */
export function shaFor(shasums: string, file: string): string | null {
  for (const line of shasums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === file) return m[1];
  }
  return null;
}

export const distUrl = (version: string, file: string): string => `${DIST}/${version}/${file}`;

type Fetcher = (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;

/** 这在 spawn 内部运行，所以绝不能挂住启动：不可达的 nodejs.org 必须快速
 *  失败，把阶梯降到下一级。 */
const timedFetch: Fetcher = (url) =>
  fetch(url, { signal: AbortSignal.timeout(6000) }) as unknown as ReturnType<Fetcher>;

/** 解析本机要运行的精确安装包，包括校验和。
 *  任何失败都返回 null（离线、不支持的平台、产物不在 SHASUMS256 中）——
 *  调用方随后沿阶梯回退，而不是瞎猜。 */
export async function resolveNodeInstaller(
  platform: string = process.platform,
  arch: string = process.arch,
  fetchImpl: Fetcher = timedFetch
): Promise<NodeInstaller | null> {
  try {
    const indexRes = await fetchImpl(`${DIST}/index.json`);
    if (!indexRes.ok) return null;
    const index = JSON.parse(await indexRes.text()) as NodeDistEntry[];
    const lts = pickLatestLts(index);
    if (!lts) return null;

    const artifact = nodeArtifactFor(lts.version, platform, arch);
    if (!artifact) return null;

    const shaRes = await fetchImpl(`${DIST}/${lts.version}/SHASUMS256.txt`);
    if (!shaRes.ok) return null;
    const sha256 = shaFor(await shaRes.text(), artifact.file);
    // 没有摘要 → 我们就要以 root 运行一个未经验证的安装包。拒绝。
    if (!sha256) return null;

    return {
      version: lts.version,
      npmVersion: lts.npm,
      file: artifact.file,
      url: distUrl(lts.version, artifact.file),
      sha256,
      kind: artifact.kind
    };
  } catch {
    return null;
  }
}

/** 可见的安装脚本：下载 → 校验 → 安装，任何一步失败即中止。
 *
 *  POSIX 形式是供 `$SHELL -lc` 使用的换行分隔语句。Windows 形式是
 *  一条 `&` 串联、且不含双引号的 cmd.exe 命令——它会被原样包在
 *  `cmd /d /s /c "<script>"` 里，其中任何一个内嵌引号都会提前结束命令
 *  行，把剩余部分当垃圾执行。 */
export function buildNodeInstallScript(installer: NodeInstaller, platform: string): string[] {
  const { version, url, sha256, file } = installer;

  if (platform === 'win32') {
    // certutil 是唯一保证存在的哈希工具；比较用 `findstr` 做，因为 cmd
    // 对命令输出没有字符串相等判断。msiexec 自己的 UAC 提示就是提权——
    // 我们从不静默调用它。
    const f = `%TEMP%\\${file}`;
    return [
      `echo   正在下载 Node.js ${version} ^(官方安装器^)...`,
      `curl -fSL ${url} -o ${f}`,
      `if errorlevel 1 exit /b 1`,
      `echo   正在校验校验和...`,
      `certutil -hashfile ${f} SHA256 | findstr /i /c:${sha256} >nul`,
      `if errorlevel 1 (echo   [x] 校验和不匹配——拒绝安装 ^& exit /b 1)`,
      `echo   正在安装——如出现 Windows 提示，请确认...`,
      `msiexec /i ${f} /passive /norestart`,
      `if errorlevel 1 exit /b 1`,
      `set PATH=%ProgramFiles%\\nodejs;%PATH%`
    ];
  }

  // macOS 自带 `shasum`；Linux 自带 `sha256sum`。两者都不全带。
  const verify = platform === 'darwin'
    ? `echo "${sha256}  $__f" | shasum -a 256 -c - >/dev/null`
    : `echo "${sha256}  $__f" | sha256sum -c - >/dev/null`;
  const install = platform === 'darwin'
    ? `sudo installer -pkg "$__f" -target /`
    // Linux 没有官方安装包——tarball 就是发行物。--strip-components
    // 去掉带版本的顶层目录，让 bin/ 直接落在 /usr/local/bin。
    : `sudo tar -xJf "$__f" -C /usr/local --strip-components=1`;

  return [
    `echo '  正在下载 Node.js ${version}（官方安装器）...'`,
    `__tmp=$(mktemp -d)`,
    `__f=$__tmp/${file}`,
    `curl -fSL --progress-bar ${url} -o "$__f" || { echo '  [x] 下载失败。'; exit 1; }`,
    `echo '  正在校验校验和...'`,
    `${verify} || { echo '  [x] 校验和不匹配——拒绝安装。'; rm -rf "$__tmp"; exit 1; }`,
    `echo ''`,
    `echo '  正在安装 Node.js。如提示请输入密码——'`,
    `echo '  官方安装器会写入你的主目录之外。'`,
    `echo ''`,
    `${install} || { echo '  [x] Node 安装失败。'; rm -rf "$__tmp"; exit 1; }`,
    `rm -rf "$__tmp"`,
    // 正在运行此脚本的 shell 是在 node 存在之前捕获的 PATH。
    `PATH=/usr/local/bin:$PATH`,
    `export PATH`
  ];
}
