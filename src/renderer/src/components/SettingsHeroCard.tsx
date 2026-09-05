/**
 * Settings → General 顶部的 hero 卡片。
 *
 * 一张卡片回答"这是什么安装，我能拿它做什么"——
 * 正在运行的版本、所在的方案，以及少数几个不属于下方任何具体设置的
 * 操作（重读发布说明、star、支持项目）。
 *
 * 其内容来自本仓库内的 docs/hero.json，运行时获取并缓存——因此方案文案、
 * 赞助商或一行公告都可以不改动构建就变更。该载荷是 DATA，绝不是 markup：
 * 下面的每个字段都是 React 文本节点，所以会被转义，shared/heroPayload.ts 在任何
 * 内容到达这里之前会校验类型、截断长度并要求 https。
 *
 * 它先以应用内置默认值即时渲染，获取落地后再就地升级，所以对话框从不等网络，
 * 离线读起来也一样。空着的赞助商槽位渲染为 NOTHING，而不是"此处放你的 logo"占位。
 *
 * 自 0.4.5 起它借用发布 drop 的表达方式（墨色边框、淡紫公告块、深色优惠带），
 * 并承载 v0.5.0 Pro 公告和 Founders' Wall 优惠，让人在 Settings 看到的那张卡片
 * 与发布 modal 说的是同一件事。方案标签和简介仍来自 hero.json。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { DEFAULT_HERO, type HeroPayload } from '@shared/heroPayload';
import { manualDownloadUrl, pendingVersion, reduceStatus, type UpdateStatus } from '@shared/updateState';

const GITHUB_REPO_URL = 'https://github.com/chaitanyagiri/munder-difflin';
const FOUNDERS_WALL_URL = 'https://munderdiffl.in/wall.html';
const DISCORD_URL = 'https://discord.gg/SEDzP5ZPk5';

export function SettingsHeroCard() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  // 以编译内置的默认值起步，所以请求在途时没有空框或 spinner——
  // 只在有变化的时候填上内容。
  const [hero, setHero] = useState<HeroPayload>(DEFAULT_HERO);
  /** updater 所知道的任何发布版本，让卡片能在版本号旁边直接提供手动下载。 */
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const off = window.cth.onUpdateStatus?.((next) => setStatus((prev) => reduceStatus(prev, next)));
    void window.cth.updateCurrent?.().then((cur) => {
      if (cur) setStatus((prev) => reduceStatus(prev, cur));
    }).catch(() => { /* push 通道仍可用 */ });
    return off;
  }, []);
  const pending = version ? pendingVersion(status, version) : null;
  const downloadManually = () => {
    if (!status) return;
    const url = manualDownloadUrl(status, window.cth.platform, window.cth.arch);
    if (url) void window.cth.updateOpenRelease(url);
  };

  useEffect(() => {
    let alive = true;
    window.cth.appInfo()
      .then((i) => { if (alive) setVersion(i.version); })
      .catch(() => { /* 没有它卡片也仍然有用 */ });
    window.cth.heroPayload()
      .then((r) => { if (alive) setHero(r.hero); })
      .catch(() => { /* 默认值已渲染 */ });
    return () => { alive = false; };
  }, []);

  const PLAN = hero.plan;
  const SPONSOR = hero.sponsor;

  /** 重新显示发布说明。UpdateToast 拥有那个界面——它持有最近的状态和 drop 渲染器——
   *  所以这里是请求而非复制，通过与 App 打开 Settings 相同的 CustomEvent 约定。 */
  const showReleaseNotes = () => {
    window.dispatchEvent(new CustomEvent('cth:show-release-notes'));
  };

  const INK = 'var(--cth-ink-900)';
  const MONO = 'var(--cth-font-mono, monospace)';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--cth-paper-100)',
      border: `2px solid ${INK}`
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
        {/* 身份：名称、一目了然的运行中版本、方案。 */}
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 13, lineHeight: '20px', color: INK
            }}>{t('settingsHero.brandName')}</span>
            {version && (
              <span style={{
                fontFamily: MONO, fontSize: 15, fontWeight: 700, color: INK
              }}>v{version}</span>
            )}
            <span style={{
              fontFamily: MONO, fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase',
              padding: '2px 7px', background: 'var(--cth-mint-light)',
              boxShadow: 'inset 0 0 0 1px var(--cth-mint)', color: INK
            }}>{PLAN.label}</span>
            {pending && (
              <>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--cth-ink-700)' }}>
                  {t('settingsHero.versionOut', { version: pending })}
                </span>
                <PixelButton variant="primary" size="sm" onClick={downloadManually}
                  title={t('settingsHero.downloadManualTitle')}>
                  {t('settingsHero.downloadVersion', { version: pending })}
                </PixelButton>
              </>
            )}
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.5, color: 'var(--cth-ink-700)', maxWidth: '64ch' }}>
            {PLAN.blurb}
          </div>
        </div>

        {/* 一行公告（事故、迁移提醒），当设置时显示。 */}
        {hero.notice && (
          <div style={{
            padding: '8px 10px', fontSize: 12, lineHeight: 1.5, color: INK,
            background: 'var(--cth-lemon-light)', border: `2px solid ${INK}`
          }}>{hero.notice}</div>
        )}

        {/* Pro 公告。与发布 drop 携带的同一块内容。 */}
        <div style={{
          padding: '12px 14px',
          background: 'var(--cth-lilac-light)',
          border: `2px solid ${INK}`
        }}>
          <span style={{
            display: 'inline-block', fontFamily: MONO, fontSize: 9, letterSpacing: '.18em',
            textTransform: 'uppercase', padding: '2px 7px',
            background: INK, color: 'var(--cth-paper-100)'
          }}>{t('settingsHero.announcement')}</span>
          <div style={{
            marginTop: 8, fontFamily: MONO, fontSize: 14, fontWeight: 700, color: INK
          }}>{t('settingsHero.proLaunch')}</div>
          <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.5, color: 'var(--cth-ink-700)', maxWidth: '64ch' }}>
            <b style={{ color: INK }}>{t('settingsHero.proCommunityFree')}</b>{' '}
            {t('settingsHero.proParagraph')}
          </div>
        </div>

        {/* Founders' Wall 优惠。 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          padding: '12px 14px',
          background: INK, color: 'var(--cth-paper-100)',
          marginTop: 2
        }}>
          <div style={{
            fontFamily: MONO, fontSize: 30, fontWeight: 700, lineHeight: 0.9,
            letterSpacing: '-.05em', color: 'var(--cth-lemon)', textAlign: 'center', flexShrink: 0
          }}>
            50<span style={{
              display: 'block', fontSize: 8, letterSpacing: '.2em', fontWeight: 500,
              color: 'var(--cth-paper-100)', opacity: 0.7, marginTop: 5
            }}>% OFF</span>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>{t('settingsHero.foundersWallTitle')}</div>
            <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.85, marginTop: 2 }}>
              {t('settingsHero.foundersWallBody')}
            </div>
          </div>
          <PixelButton variant="primary" size="sm" onClick={() => void window.cth.openExternal(FOUNDERS_WALL_URL)}>
            {t('settingsHero.seeTheWall')}
          </PixelButton>
          {PLAN.upgrade && (
            <PixelButton variant="secondary" size="sm" onClick={() => void window.cth.openExternal(PLAN.upgrade!.url)}>
              {PLAN.upgrade.label}
            </PixelButton>
          )}
        </div>

        {/* 赞助商——仅当存在时。 */}
        {SPONSOR && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: 10,
            background: 'var(--cth-cream-100)',
            border: `2px solid ${INK}`
          }}>
            <span style={{
              fontFamily: MONO, fontSize: 9, letterSpacing: '.18em',
              textTransform: 'uppercase', color: 'var(--cth-ink-500)', flexShrink: 0
            }}>{t('settingsHero.sponsoredBy')}</span>
            <span style={{ fontSize: 13, color: INK, flexShrink: 0 }}>{SPONSOR.name}</span>
            <span style={{ flex: 1, minWidth: 120, fontSize: 12, color: 'var(--cth-ink-700)' }}>{SPONSOR.blurb}</span>
            <PixelButton variant="ghost" size="sm" onClick={() => void window.cth.openExternal(SPONSOR.url)}>
              {t('settingsHero.visit')}
            </PixelButton>
          </div>
        )}

        {/* 属于应用本身、而非下方任何设置的行动。 */}
        <div style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
          paddingTop: 12, borderTop: `2px solid ${INK}`
        }}>
          <PixelButton variant="secondary" size="sm" onClick={showReleaseNotes}>
            <span title={t('settingsHero.whatsNewTitle')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="sparkle" /> {t('settingsHero.whatsNew')}
            </span>
          </PixelButton>
          <PixelButton variant="secondary" size="sm" onClick={() => void window.cth.openExternal(GITHUB_REPO_URL)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              ⭐ {t('settingsHero.starOnGitHub')}
            </span>
          </PixelButton>
          <PixelButton variant="secondary" size="sm" onClick={() => void window.cth.openExternal(DISCORD_URL)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              💬 {t('settingsHero.joinDiscord')}
            </span>
          </PixelButton>
          <PixelButton
            variant="ghost"
            size="sm"
            onClick={() => void window.cth.openExternal(`${GITHUB_REPO_URL}/issues/new`)}
          >{t('settingsHero.reportProblem')}</PixelButton>
          <span style={{ flex: 1 }} />
          <a
            href={`${GITHUB_REPO_URL}/blob/main/CHANGELOG.md`}
            onClick={(e) => { e.preventDefault(); void window.cth.openExternal(`${GITHUB_REPO_URL}/blob/main/CHANGELOG.md`); }}
            style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}
          >{t('settingsHero.fullChangelog')}</a>
        </div>
      </div>
    </div>
  );
}
