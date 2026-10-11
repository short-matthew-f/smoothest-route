export const DEFAULT_SETTINGS = {
  home:  { name: 'Litchfield', lat: 41.7473, lng: -73.1887 },
  work:  { name: 'CT Science Center', lat: 41.7648, lng: -72.6690 },
  maxPenaltyMin: 10,
  alternatives: 1,   // extra alternative routes requested per candidate (integer 0..3)
  apiKey: '',
  corridors: [
    { id: 'rt4',     name: 'Rt 4',            enabled: true, vias: [{ lat: 41.7738, lng: -72.9495 }], avoidHighways: false, note: 'CT-4 Spielman Hwy, Burlington' },
    { id: 'us202',   name: 'US 202 → Rt 44',  enabled: true, vias: [{ lat: 41.8296, lng: -72.9023 }], avoidHighways: false, note: 'US-44 Albany Tpke, Canton' },
    // viasReturn (optional, non-empty) is used instead of vias for the To-home direction (divided highway).
    { id: 'rt8',     name: 'Rt 8 → I-84',     enabled: true, vias: [{ lat: 41.5380, lng: -73.0040 }], viasReturn: [{ lat: 41.5382, lng: -73.0040 }], avoidHighways: false, note: 'I-84 east of Rt 8; divided highway so return uses the westbound carriageway' },
    { id: 'nohwy',   name: 'No highways',     enabled: true, vias: [], avoidHighways: true, note: 'HERE fastest route avoiding controlled-access highways' },
  ],
};
export const FASTEST_ID = 'fastest';   // the no-via HERE route, always evaluated
