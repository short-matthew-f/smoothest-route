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
