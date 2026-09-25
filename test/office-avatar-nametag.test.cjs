'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Texture, Rectangle } = require('pixi.js');

// Pixi measures Text with canvas in the browser. The unit tests only assert the
// label contents and placement, so a tiny deterministic measurer is enough.
const fakeContext = {
  font: '',
  measureText(text) {
    return {
      width: text.length * 6,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 6,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
    };
  },
};
globalThis.CanvasRenderingContext2D = class {};
globalThis.document = {
  createElement() {
    return {
      width: 0,
      height: 0,
      style: {},
      getContext: () => fakeContext,
    };
  },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const loadTs = require('./load-ts.cjs');
const { CharacterSprite } = loadTs('src/renderer/src/scene/office/CharacterSprite.ts');
const officeSource = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'renderer', 'src', 'scene', 'office', 'OfficeFloor.tsx'),
  'utf8'
);

function makeSprite() {
  const frame = new Texture({ frame: new Rectangle(0, 0, 16, 32) });
  const frames = Array.from({ length: 3 }, () => Array.from({ length: 7 }, () => frame));
  return new CharacterSprite(frames);
}

test('an avatar nametag rides the sprite container below the feet', () => {
  const sprite = makeSprite();

  sprite.setName('Ada');
  const tagIndex = sprite.container.children.findIndex((child) => child.text === 'Ada');
  assert.notEqual(tagIndex, -1, 'the nametag must be a child of the avatar container');

  const label = sprite.container.children[tagIndex];
  assert.equal(label.visible, true);
  assert.equal(label.eventMode, 'none', 'the nametag must not steal avatar clicks');
  assert.equal(sprite.container.children[tagIndex - 1].visible, true, 'the tag has a readable chip');
  assert.ok(label.y > 0, 'the label sits below the avatar feet baseline');
  assert.ok(sprite.container.children[tagIndex - 1].bounds.maxY > 0, 'the chip sits below the avatar feet');
});

test('a live rename replaces the nametag and an empty name hides it', () => {
  const sprite = makeSprite();
  sprite.setName('  Ada  ');
  assert.equal(sprite.container.children.at(-1).text, 'Ada');

  sprite.setName('A Very Long Agent Name');
  assert.equal(sprite.container.children.at(-1).text, 'A Very Long…');

  sprite.setName('   ');
  assert.equal(sprite.container.children.at(-1).visible, false);
});

test('the store tick keeps the nametag synchronized after a rename', () => {
  assert.match(officeSource, /rt\.prevName !== agent\.name/);
  assert.match(officeSource, /c\.setDisplayName\(agent\.name\)/);
  assert.match(officeSource, /displayName: agent\.name/);
});
