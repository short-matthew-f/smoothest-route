// Pure helpers that build deep links into Google Maps / Apple Maps.

const pt = (p) => `${p.lat},${p.lng}`;

/** Google Maps directions URL with optional via waypoint. */
export function googleMapsUrl({ origin, destination, via }) {
  let url = `https://www.google.com/maps/dir/?api=1&origin=${pt(origin)}&destination=${pt(destination)}`;
  if (via) url += `&waypoints=${pt(via)}`;
  return `${url}&travelmode=driving`;
}

/** Apple Maps URL. Apple has no via param; chain stops in daddr with "+to:". */
export function appleMapsUrl({ origin, destination, via }) {
  const daddr = via ? `${pt(via)}+to:${pt(destination)}` : pt(destination);
  return `https://maps.apple.com/?saddr=${pt(origin)}&daddr=${daddr}&dirflg=d`;
}

/** True for iPhone/iPad/iPod/Mac user agents. */
export function isApplePlatform(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  return /iPhone|iPad|iPod|Macintosh/i.test(ua || '');
}
