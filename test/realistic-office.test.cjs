const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./load-ts.cjs');
const { removePreviewMatte } = load('src/renderer/src/scene/office/spriteMatte.ts');
const { officeScreenRect, officeSeatOffset } = load('src/renderer/src/scene/office/realisticOfficeLayout.ts');

test('employee matte clears connected preview squares but preserves enclosed white clothing', () => {
  const width = 7, height = 7;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const shade = (x + y) % 2 ? 238 : 255;
    data.set([shade, shade, shade, 255], (y * width + x) * 4);
  }
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) {
    data.set([35, 40, 48, 255], (y * width + x) * 4);
  }
  data.set([250, 250, 250, 255], (3 * width + 3) * 4);
  removePreviewMatte(data, width, height);
  assert.equal(data[3], 0);
  assert.equal(data[(3 * width + 3) * 4 + 3], 255);
  assert.equal(data[(2 * width + 2) * 4 + 3], 255);
  assert.equal(data[(6 * width + 6) * 4 + 3], 0);
});

test('already transparent employee artwork is not re-keyed', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]);
  const before = data.slice();
  removePreviewMatte(data, 2, 1);
  assert.deepEqual(data, before);
});

test('every existing office monitor and seat has bounded photo registration', () => {
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/renderer/src/assets/maps/office.tmj'), 'utf8'));
  const layer = map.layers.find((layer) => layer.name === 'furniture-above');
  let count = 0;
  layer.data.forEach((gid, index) => {
    if (gid !== 365) return;
    count++;
    const tile = { x: index % map.width, y: Math.floor(index / map.width) };
    const screen = officeScreenRect(tile);
    assert.ok(screen, `missing screen at ${tile.x},${tile.y}`);
    assert.ok(screen.w > 10 && screen.h > 5);
    assert.ok(tile.x * 16 + screen.x >= 0 && tile.y * 16 + screen.y >= 0);
    const offset = officeSeatOffset({ x: tile.x, y: tile.y + 2 });
    assert.ok(Math.abs(offset.x) < 16 && Math.abs(offset.y) < 16, 'registration must stay within the chair footprint');
  });
  assert.equal(count, 16);
  assert.equal(officeScreenRect({ x: 0, y: 0 }), undefined);
  assert.deepEqual(officeSeatOffset({ x: 12, y: 15 }), { x: 0, y: 0 });
});
