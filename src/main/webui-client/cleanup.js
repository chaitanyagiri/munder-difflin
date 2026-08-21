/*
 * Runs right after the preload bundle (see boot.js). The CJS shim globals were
 * only ever for that one script — leaving a fake `require`/`module` on window
 * would trip AMD/UMD environment sniffers in the renderer's own dependencies.
 */
(function () {
  'use strict';
  try { delete window.require; } catch (e) { window.require = undefined; }
  try { delete window.module; } catch (e) { window.module = undefined; }
  try { delete window.exports; } catch (e) { window.exports = undefined; }
})();
