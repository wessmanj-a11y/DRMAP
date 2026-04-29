/* DRMAP live data exporter
   Purpose: expose the real computed DRMAP runtime values to DR2MAP without scraping or fake data.
   This script should be loaded after DRMAP's main script.
*/
(function(){
  function safeNumber(value){
    const n = Number(String(value ?? 0).replace(/[^0-9.-]/g,''));
    return Number.isFinite(n) ? n : 0;
  }

  function readText(id){
    return document.getElementById(id)?.innerText?.trim() || '—';
  }

  function getCountyData(){
    try {
      if (typeof countyData === 'undefined' || !countyData) return [];
      return Object.values(countyData).map(c => ({
        name: c.name,
        customersOut: safeNumber(c.customersOut),
        incidents: safeNumber(c.incidents),
        maxSingleOutage: safeNumber(c.maxSingleOutage),
        currentSeverity: safeNumber(c.currentSeverity),
        predictedRisk: safeNumber(c.predictedRisk),
        predictedRiskBand: c.predictedRiskBand || 'Low',
        trend24h: c.trend24h,
        sevenDayPeak: c.sevenDayPeak,
        weatherAlerts: safeNumber(c.weatherAlerts),
        weatherRisk: safeNumber(c.weatherRisk),
        weatherEvents: c.weatherEvents || [],
        roadClosures: safeNumber(c.roadClosures),
        roadClosureRisk: safeNumber(c.roadClosureRisk),
        roadEvents: c.roadEvents || [],
        restorationDifficulty: safeNumber(c.restorationDifficulty),
        predictionExplanation: c.predictionExplanation || '',
        points: c.points || []
      }));
    } catch (error) {
      console.warn('DRMAP exporter county read failed', error);
      return [];
    }
  }

  function buildExport(){
    const counties = getCountyData();
    return {
      type: 'DRMAP_LIVE_EXPORT',
      generatedAt: new Date().toISOString(),
      summary: {
        customersOut: readText('totalCustomers'),
        countiesImpacted: readText('countyImpacted'),
        severeCounties: readText('severeCounties'),
        topPredictedRisk: readText('highestPredicted'),
        weatherAlerts: readText('weatherAlerts'),
        trend24h: readText('trendMetric'),
        hospitalOccupancy: readText('hospitalOccupancy'),
        gridStress: readText('gridStress')
      },
      selectedCounty: {
        name: readText('selectedName'),
        severity: readText('severity'),
        predictedRisk: readText('predictedRisk'),
        customersOut: readText('countyCustomers'),
        incidents: readText('countyIncidents'),
        weatherAlerts: readText('countyWeather'),
        trend24h: readText('trend24h'),
        sevenDayPeak: readText('sevenDayPeak'),
        maxSingleOutage: readText('maxSingle'),
        roadClosures: readText('roadClosures'),
        restorationDifficulty: readText('restorationDifficulty'),
        scoreExplanation: readText('scoreExplain')
      },
      counties
    };
  }

  function publish(){
    const payload = buildExport();
    window.DRMAP_LIVE_EXPORT = payload;
    try {
      window.parent?.postMessage(payload, window.location.origin);
    } catch (error) {
      console.warn('DRMAP exporter postMessage failed', error);
    }
  }

  window.getDRMAPLiveExport = buildExport;
  window.publishDRMAPLiveExport = publish;

  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'REQUEST_DRMAP_LIVE_EXPORT') publish();
  });

  setInterval(publish, 3000);
  window.addEventListener('load', () => {
    setTimeout(publish, 1500);
    setTimeout(publish, 5000);
    setTimeout(publish, 10000);
  });
})();
