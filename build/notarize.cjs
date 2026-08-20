// electron-builder `afterSign` hook — notarize + staple the macOS app.
//
// It runs ONLY when notarization credentials are present in the environment, so
// contributors without an Apple account can still `npm run dist:mac` and get a
// working (unsigned) build — this just no-ops. With a Developer ID cert in the
// keychain + the env vars below, the produced .app/.dmg is signed, notarized,
// and stapled, so end users get a single one-time macOS access prompt.
//
// Credentials (set whichever pair you use):
//   App-specific password:  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
//   App Store Connect key:  APPLE_API_KEY (path to .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Ad-hoc sign the bundle when there is no Developer ID identity to sign with.
 *
 * Without this the app ships with NO valid signature at all — `codesign
 * --verify` reports "code object is not signed at all", and macOS will not
 * persist a TCC grant for a bundle whose identity it cannot validate. The
 * practical effect is the one this config exists to prevent: the folder-access
 * prompt returns on EVERY agent file touch instead of being answered once. An
 * ad-hoc signature is not distributable and Gatekeeper still blocks it for
 * other users, but it is self-consistent, which is all TCC needs to remember
 * the grant on the machine that built it.
 *
 * Deliberately best-effort: a contributor without Xcode's command line tools
 * should still end up with a working (if re-prompting) build rather than a
 * failed release.
 */
function adhocSign(context) {
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const entitlements = path.join(__dirname, 'entitlements.mac.plist');
  try {
    execFileSync('codesign', [
      '--force', '--deep', '--sign', '-',
      '--options', 'runtime',
      '--entitlements', entitlements,
      appPath
    ], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    console.log('[notarize] ad-hoc signed the app so macOS can remember folder-access grants.');
  } catch (err) {
    console.warn('[notarize] ⚠️  ad-hoc signing failed — macOS will re-prompt for folder access on every agent action.');
    console.warn(`[notarize] codesign said: ${err && err.message ? err.message : err}`);
  }
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return; // mac only

  const {
    APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID,
    APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER
  } = process.env;

  const hasPassword = !!(APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID);
  const hasApiKey = !!(APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER);
  if (!hasPassword && !hasApiKey) {
    console.log('[notarize] no APPLE_* credentials in env — skipping notarization.');
    adhocSign(context);
    return;
  }

  let notarize;
  try {
    ({ notarize } = require('@electron/notarize'));
  } catch {
    console.warn('[notarize] @electron/notarize not installed — run `npm install`. Skipping.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const creds = hasApiKey
    ? { appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER }
    : { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID };

  console.log(`[notarize] submitting ${appName}.app to Apple via notarytool (this can take a few minutes)…`);
  try {
    await notarize({ tool: 'notarytool', appPath, ...creds });
    console.log('[notarize] stapling ticket to the app…');
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
    console.log('[notarize] done — app is signed, notarized, and stapled.');
  } catch (err) {
    // Best-effort: notarization talks to Apple's servers and can fail for reasons
    // outside the build (bad/expired app-specific password, unaccepted Developer
    // Program agreement, Apple-side outage, a rejected submission). That must NOT
    // sink the whole cross-platform release — the app is still Developer ID *signed*,
    // which is what gives the stable identity macOS uses to remember folder-access
    // grants (the one-time prompt). So we log loudly and ship the signed build;
    // once the credentials are valid, the next release notarizes with no code change.
    // Un-notarized = users may need a one-time right-click → Open on first launch.
    console.warn('[notarize] ⚠️  NOTARIZATION FAILED — shipping a signed-but-unnotarized build.');
    console.warn('[notarize] Fix the APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID secrets to enable it.');
    console.warn(`[notarize] notarytool said:\n${err && err.message ? err.message : err}`);
  }
};
