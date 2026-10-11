export const DEFAULT_SETTINGS = {
  home:  { name: 'Litchfield', lat: 41.7473, lng: -73.1887 },
  work:  { name: 'Hartford',   lat: 41.7637, lng: -72.6851 },
  maxPenaltyMin: 10,
  apiKey: '',
  corridors: [
    { id: 'rt4',     name: 'Rt 4',            enabled: true, via: { lat: 41.7738, lng: -72.9495 }, note: 'CT-4 Spielman Hwy, Burlington' },
    { id: 'us202',   name: 'US 202 → Rt 44',  enabled: true, via: { lat: 41.8296, lng: -72.9023 }, note: 'US-44 Albany Tpke, Canton' },
    // viaReturn (optional) is used instead of via for the To-home direction (divided highway).
    { id: 'rt8',     name: 'Rt 8 → I-84',     enabled: true, via: { lat: 41.5380, lng: -73.0040 }, viaReturn: { lat: 41.5382, lng: -73.0040 }, note: 'I-84 east of Rt 8; divided highway so return uses the westbound carriageway' },
  ],
};
export const FASTEST_ID = 'fastest';   // the no-via HERE route, always evaluated
