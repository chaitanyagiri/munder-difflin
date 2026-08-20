/**
 * The hero card at the top of Settings → General.
 *
 * One card that answers "what is this install, and what can I do about it" —
 * the running version, the plan it is on, and the handful of actions that do not
 * belong to any individual setting below (re-read the release notes, star, back
 * the project).
 *
 * Its contents come from docs/hero.json IN THIS REPO, fetched at runtime and
 * cached — so plan copy, a sponsor, or a one-line notice can change without
 * shipping a build. That payload is DATA, never markup: every field below is a
 * React text node, so it is escaped, and shared/heroPayload.ts validates types,
 * caps lengths and requires https before any of it reaches here.
 *
 * It renders instantly from the app's built-in defaults and upgrades in place
 * when the fetch lands, so the dialog never waits on the network and reads the
 * same offline. A sponsor slot with nothing in it renders NOTHING rather than a
 * "your logo here" placeholder.
 *
 * Deliberately not a marketing panel: no gradient, no pitch. It sits above the
 * update section in a settings dialog, and anything louder than the settings it
 * introduces would be noise every time someone opens this to change a folder.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { DEFAULT_HERO, type HeroPayload } from '@shared/heroPayload';

const GITHUB_REPO_URL = 'https://github.com/chaitanyagiri/munder-difflin';

export function SettingsHeroCard() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  // Starts on the compiled-in defaults, so there is no empty frame or spinner
  // while the fetch is in flight — it just fills in if anything changed.
  const [hero, setHero] = useState<HeroPayload>(DEFAULT_HERO);

  useEffect(() => {
    let alive = true;
    window.cth.appInfo()
      .then((i) => { if (alive) setVersion(i.version); })
      .catch(() => { /* the card is still useful without it */ });
    window.cth.heroPayload()
      .then((r) => { if (alive) setHero(r.hero); })
      .catch(() => { /* defaults already rendered */ });
    return () => { alive = false; };
  }, []);

  const PLAN = hero.plan;
  const SPONSOR = hero.sponsor;

  /** Re-show the release notes. UpdateToast owns that surface — it holds the
   *  last status and the drop renderer — so this asks rather than duplicating
   *  it, via the same CustomEvent convention App uses for opening Settings. */
  const showReleaseNotes = () => {
    window.dispatchEvent(new CustomEvent('cth:show-release-notes'));
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 14,
      padding: 16,
      background: 'var(--cth-cream-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      {/* Identity */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 13, lineHeight: '20px',
              color: 'var(--cth-ink-900)'
            }}>MUNDER DIFFLIN</span>
            {version && (
              <span style={{
                fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12,
                color: 'var(--cth-ink-500)'
              }}>v{version}</span>
            )}
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 9, letterSpacing: 0.5,
              textTransform: 'uppercase', padding: '2px 7px',
              background: 'var(--cth-mint-light)',
              boxShadow: 'inset 0 0 0 1px var(--cth-mint)',
              color: 'var(--cth-ink-900)'
            }}>{PLAN.label}</span>
          </div>
          <div style={{
            marginTop: 6, fontSize: 12.5, lineHeight: 1.5, color: 'var(--cth-ink-700)', maxWidth: '58ch'
          }}>{PLAN.blurb}</div>
        </div>

        {PLAN.upgrade && (
          <PixelButton
            variant="primary"
            size="sm"
            onClick={() => void window.cth.openExternal(PLAN.upgrade!.url)}
          >{PLAN.upgrade.label}</PixelButton>
        )}
      </div>

      {/* A one-line notice (an incident, a migration heads-up), when set. */}
      {hero.notice && (
        <div style={{
          padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
          color: 'var(--cth-ink-900)',
          background: 'var(--cth-lemon-light)',
          boxShadow: 'inset 0 0 0 1px var(--cth-lemon)'
        }}>{hero.notice}</div>
      )}

      {/* Sponsor — only when there is one. */}
      {SPONSOR && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: 10,
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <span style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 9, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--cth-ink-500)', flexShrink: 0
          }}>{t('settingsHero.sponsoredBy')}</span>
          <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', flexShrink: 0 }}>{SPONSOR.name}</span>
          <span style={{ flex: 1, minWidth: 120, fontSize: 12, color: 'var(--cth-ink-700)' }}>{SPONSOR.blurb}</span>
          <PixelButton variant="ghost" size="sm" onClick={() => void window.cth.openExternal(SPONSOR.url)}>
            {t('settingsHero.visit')}
          </PixelButton>
        </div>
      )}

      {/* Actions that belong to the app rather than to any setting below. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
  );
}
