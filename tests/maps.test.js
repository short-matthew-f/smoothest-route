import test from 'node:test';
import assert from 'node:assert/strict';
import { googleMapsUrl, appleMapsUrl, isApplePlatform } from '../src/maps.js';

const origin = { lat: 41.7473, lng: -73.1887 };
const destination = { lat: 41.7637, lng: -72.6851 };
const via = { lat: 41.757, lng: -72.887 };

test('googleMapsUrl with via includes waypoints', () => {
  assert.equal(
    googleMapsUrl({ origin, destination, via }),
    'https://www.google.com/maps/dir/?api=1&origin=41.7473,-73.1887&destination=41.7637,-72.6851&waypoints=41.757,-72.887&travelmode=driving'
  );
});

test('googleMapsUrl omits waypoints without via', () => {
  const u = googleMapsUrl({ origin, destination });
  assert.ok(!u.includes('waypoints'));
  assert.equal(u, 'https://www.google.com/maps/dir/?api=1&origin=41.7473,-73.1887&destination=41.7637,-72.6851&travelmode=driving');
  assert.ok(!googleMapsUrl({ origin, destination, via: null }).includes('waypoints'));
});

test('appleMapsUrl chains via with +to:', () => {
  assert.equal(
    appleMapsUrl({ origin, destination, via }),
    'https://maps.apple.com/?saddr=41.7473,-73.1887&daddr=41.757,-72.887+to:41.7637,-72.6851&dirflg=d'
  );
});

test('appleMapsUrl without via is a plain destination', () => {
  assert.equal(
    appleMapsUrl({ origin, destination }),
    'https://maps.apple.com/?saddr=41.7473,-73.1887&daddr=41.7637,-72.6851&dirflg=d'
  );
});

const via2 = { lat: 41.8, lng: -72.9 };
const G = 'https://www.google.com/maps/dir/?api=1&origin=41.7473,-73.1887&destination=41.7637,-72.6851';
const AP = 'https://maps.apple.com/?saddr=41.7473,-73.1887&daddr=';

test('googleMapsUrl with vias array: 0, 1 and 2 waypoints', () => {
  assert.equal(googleMapsUrl({ origin, destination, vias: [] }), `${G}&travelmode=driving`);
  assert.equal(googleMapsUrl({ origin, destination, vias: [via] }), `${G}&waypoints=41.757,-72.887&travelmode=driving`);
  assert.equal(
    googleMapsUrl({ origin, destination, vias: [via, via2] }),
    `${G}&waypoints=41.757,-72.887%7C41.8,-72.9&travelmode=driving`
  );
});

test('googleMapsUrl vias takes precedence over legacy via', () => {
  assert.equal(
    googleMapsUrl({ origin, destination, via, vias: [via2] }),
    `${G}&waypoints=41.8,-72.9&travelmode=driving`
  );
});

test('googleMapsUrl avoidHighways appends &avoid=highways', () => {
  assert.equal(googleMapsUrl({ origin, destination, avoidHighways: true }), `${G}&travelmode=driving&avoid=highways`);
  assert.equal(
    googleMapsUrl({ origin, destination, vias: [via], avoidHighways: true }),
    `${G}&waypoints=41.757,-72.887&travelmode=driving&avoid=highways`
  );
  assert.ok(!googleMapsUrl({ origin, destination, avoidHighways: false }).includes('avoid'));
  assert.ok(!googleMapsUrl({ origin, destination }).includes('avoid'));
});

test('appleMapsUrl with vias array: 0, 1 and 2 stops chained with +to:', () => {
  assert.equal(appleMapsUrl({ origin, destination, vias: [] }), `${AP}41.7637,-72.6851&dirflg=d`);
  assert.equal(appleMapsUrl({ origin, destination, vias: [via] }), `${AP}41.757,-72.887+to:41.7637,-72.6851&dirflg=d`);
  assert.equal(
    appleMapsUrl({ origin, destination, vias: [via, via2] }),
    `${AP}41.757,-72.887+to:41.8,-72.9+to:41.7637,-72.6851&dirflg=d`
  );
  assert.ok(!appleMapsUrl({ origin, destination, avoidHighways: true }).includes('avoid'));
});

test('isApplePlatform detects Apple user agents', () => {
  assert.equal(isApplePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'), true);
  assert.equal(isApplePlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), true);
  assert.equal(isApplePlatform('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)'), true);
  assert.equal(isApplePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), true);
});

test('isApplePlatform false for others and empty', () => {
  assert.equal(isApplePlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36'), false);
  assert.equal(isApplePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'), false);
  assert.equal(isApplePlatform(''), false);
});
