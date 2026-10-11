// Pure helpers that build deep links into Google Maps / Apple Maps.

const pt = (p) => `${p.lat},${p.lng}`;

// Normalise `vias` (array) and legacy `via` (single point) into an array of points.
function viaList(vias, via) {
  if (Array.isArray(vias)) return vias.filter(Boolean);
  return via ? [via] : [];
}

/**
 * Google Maps directions URL with optional via waypoints (pipe-separated, %7C-encoded).
 * `avoidHighways` appends `&avoid=highways` (honoured only by some Google Maps forms).
 */
export function googleMapsUrl({ origin, destination, via, vias, avoidHighways }) {
  let url = `https://www.google.com/maps/dir/?api=1&origin=${pt(origin)}&destination=${pt(destination)}`;
  const list = viaList(vias, via);
  if (list.length) url += `&waypoints=${list.map(pt).join('%7C')}`;
  url += '&travelmode=driving';
  if (avoidHighways) url += '&avoid=highways';
  return url;
}

/** Apple Maps URL. Apple has no via param; chain stops in daddr with "+to:". */
export function appleMapsUrl({ origin, destination, via, vias }) {
  const daddr = [...viaList(vias, via), destination].map(pt).join('+to:');
  return `https://maps.apple.com/?saddr=${pt(origin)}&daddr=${daddr}&dirflg=d`;
}

/** True for iPhone/iPad/iPod/Mac user agents. */
export function isApplePlatform(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  return /iPhone|iPad|iPod|Macintosh/i.test(ua || '');
}
