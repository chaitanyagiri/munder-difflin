'use strict';

// #595: on an unattended host the launch-time harness-config picker held the
// whole floor — nothing spawned until someone clicked "open", and every restart
// re-armed it. openLastHiveOnLaunch lets a launch skip straight to harnessHome.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { shouldAutoOpenHive, isFloorState } = loadTs('src/shared/hivePicker.ts');

const onboarded = { onboardingComplete: true, harnessHome: '/home/munder/munderdifflin-hive' };

test('the picker still shows by default', () => {
  assert.equal(shouldAutoOpenHive(onboarded), false);
  assert.equal(shouldAutoOpenHive({ ...onboarded, openLastHiveOnLaunch: false }), false);
});

test('openLastHiveOnLaunch skips the picker for a known harnessHome', () => {
  assert.equal(shouldAutoOpenHive({ ...onboarded, openLastHiveOnLaunch: true }), true);
});

test('with nothing to reopen, the picker (or onboarding) stays', () => {
  assert.equal(shouldAutoOpenHive({ ...onboarded, harnessHome: null, openLastHiveOnLaunch: true }), false);
  assert.equal(shouldAutoOpenHive({ ...onboarded, harnessHome: '   ', openLastHiveOnLaunch: true }), false);
  assert.equal(shouldAutoOpenHive({ ...onboarded, onboardingComplete: false, openLastHiveOnLaunch: true }), false);
});

test('only a hand-edited literal true turns it on', () => {
  // config.json is edited by hand on headless hosts; a stray string is not consent.
  assert.equal(shouldAutoOpenHive({ ...onboarded, openLastHiveOnLaunch: 'true' }), false);
});

test('floor state reports accept only the two known values', () => {
  assert.equal(isFloorState('open'), true);
  assert.equal(isFloorState('awaiting-hive-selection'), true);
  assert.equal(isFloorState('starting'), false);
  assert.equal(isFloorState(undefined), false);
});
