const fs = require("fs/promises");

const HISTORY_OUT = "history/outage-history.json";
const TRAINING_OUT = "history/training-data.json";

const LOOKAHEAD_HOURS = 3;
const LOOKAHEAD_MS = LOOKAHEAD_HOURS * 60 * 60 * 1000;

function num(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const raw = await fs.readFile(HISTORY_OUT, "utf8");
  const history = JSON.parse(raw).snapshots || [];

  const rows = [];

  for (const snap of history) {
    const t = new Date(snap.timestamp).getTime();
    if (!Number.isFinite(t)) continue;

    const future = history
      .filter(s => {
        const ft = new Date(s.timestamp).getTime();
        return ft >= t + LOOKAHEAD_MS;
      })
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0];

    if (!future) continue;

    for (const county of snap.counties || []) {
      const futureCounty = (future.counties || []).find(
        c => String(c.county).toLowerCase() === String(county.county).toLowerCase()
      );

      if (!futureCounty) continue;

      const currentOut = num(county.customersOut);
      const futureOut = num(futureCounty.customersOut);
      const increase = futureOut - currentOut;

      const worsened =
        increase >= 500 ||
        (currentOut > 0 && futureOut >= currentOut * 1.5);

      rows.push({
        timestamp: snap.timestamp,
        futureTimestamp: future.timestamp,
        lookaheadHours: LOOKAHEAD_HOURS,
        county: county.county,

        customersOut: currentOut,
        percentCustomersOut: num(county.percentCustomersOut),
        incidents: num(county.incidents),
        maxSingleOutage: num(county.maxSingleOutage),

        weatherAlerts: num(county.weatherAlerts),
        weatherRisk: num(county.weatherRisk),
        forecastWindMax6h: num(county.forecastWindMax6h),
        forecastWindMax12h: num(county.forecastWindMax12h),
        forecastPrecipChanceMax12h: num(county.forecastPrecipChanceMax12h),
        forecastStormRisk: num(county.forecastStormRisk),

        roadClosures: num(county.roadClosures),
        roadClosureRisk: num(county.roadClosureRisk),

        trend6h: num(county.trend6h),
        trend12h: num(county.trend12h),
        trend24h: num(county.trend24h),
        trendVelocity: num(county.trendVelocity),
        sevenDayPeak: num(county.sevenDayPeak),

        futureCustomersOut: futureOut,
        outageIncrease3h: increase,
        worsened: worsened ? 1 : 0
      });
    }
  }

  await fs.writeFile(
    TRAINING_OUT,
    JSON.stringify(
      {
        updated: new Date().toISOString(),
        lookaheadHours: LOOKAHEAD_HOURS,
        rows
      },
      null,
      2
    )
  );

  console.log(`Built ${rows.length} ML training rows`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
