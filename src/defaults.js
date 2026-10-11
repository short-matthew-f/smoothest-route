export const DEFAULT_SETTINGS = {
  home:  { name: 'Litchfield', lat: 41.7473, lng: -73.1887 },
  work:  { name: 'Hartford',   lat: 41.7637, lng: -72.6851 },
  maxPenaltyMin: 10,
  apiKey: '',
  corridors: [
    { id: 'rt4',     name: 'Rt 4',            enabled: true, via: { lat: 41.7570, lng: -72.8870 }, note: 'Burlington / Unionville' },
    { id: 'us202',   name: 'US 202 → Rt 44',  enabled: true, via: { lat: 41.8100, lng: -72.8300 }, note: 'Canton / Avon' },
    { id: 'rt8',     name: 'Rt 8 → I-84',     enabled: true, via: { lat: 41.5560, lng: -73.0380 }, note: 'Waterbury interchange' },
  ],
};
export const FASTEST_ID = 'fastest';   // the no-via HERE route, always evaluated
