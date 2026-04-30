window.DRMAP_STATE = {
  mode: window.DRMAP_CONFIG.defaultMode,
  outages: [],
  countyGeo: null,
  countyData: {},
  selectedCounty: 'Harris',
  map: null,
  layers: {
    base: null,
    counties: null,
    points: null,
    weather: null,
    roads: null
  },
  toggles: {
    points: true,
    roads: true,
    weatherPolygons: true
  }
};
