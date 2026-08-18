const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const generator = require('../tools/gen-b99-map.cjs');

test('precinct generated assets are current and self-contained', () => {
  const generated = generator.generatedAssets();
  const mapPath = path.join(root, 'src/renderer/src/assets/maps/brooklyn99.tmj');
  const atlasPath = path.join(root, 'src/renderer/src/assets/tilesets/precinct-tileset.png');

  assert.deepEqual(fs.readFileSync(mapPath), generated.map);
  assert.deepEqual(fs.readFileSync(atlasPath), generated.atlas);

  const map = JSON.parse(generated.map.toString('utf8'));
  assert.equal(map.tilesets.length, 1);
  assert.equal(map.tilesets[0].image, '../tilesets/precinct-tileset.png');
  assert.match(map.properties[0].value, /Original procedural Precinct/);
  assert.deepEqual(
    new Set(map.layers.find((layer) => layer.name === 'zones').objects.map((zone) => zone.name)),
    new Set(['bullpen', 'captain-office', 'operations', 'cafeteria', 'entrance', 'boardroom', 'interrogation', 'evidence']),
  );
  assert.equal(generated.result.targets, 33);
});

test('precinct validation rejects blocked runtime targets', () => {
  const built = generator.buildMap();
  const collision = built.map.layers.find((layer) => layer.name === 'collision').data;
  const entrance = built.ENTRANCE;
  collision[entrance.y * built.map.width + entrance.x] = 1;
  built.L.coll[entrance.y * built.map.width + entrance.x] = 1;
  // Seal the tiles immediately around the force-walkable entrance.
  for (const [x, y] of [[entrance.x - 1, entrance.y], [entrance.x + 1, entrance.y], [entrance.x, entrance.y - 1], [entrance.x, entrance.y + 1]]) {
    built.L.coll[y * built.map.width + x] = 1;
  }
  assert.throws(() => generator.validate(built), /map validation failed/);
});
