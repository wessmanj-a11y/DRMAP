const DRIVETEXAS_HOSTS = [
  "https://a.static.drivetexas.org",
  "https://b.static.drivetexas.org",
  "https://c.static.drivetexas.org"
];

// Use the timestamp folder you found
const TILESET_PATH = "tileset/26/04/26/19/15/02";

const Z = 7;
const X_MIN = 25;
const X_MAX = 31;
const Y_MIN = 48;
const Y_MAX = 54;

function cleanRoadText(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tileCellToLatLon(z, x, y, cellX, cellY, gridSize = 64) {
  const n = Math.pow(2, z);

  const lon = ((x + cellX / gridSize) / n) * 360 - 180;

  const latRad = Math.atan(
    Math.sinh(Math.PI * (1 - 2 * (y + cellY / gridSize) / n))
  );

  const lat = latRad * 180 / Math.PI;

  return { lat, lon };
}

function roadRiskScore(event) {
  const type = String(event.type || "").toUpperCase();
  const desc = String(event.description || "").toLowerCase();

  let score = 0;

  if (type === "Z") score += 10;
  else if (type === "D") score += 9;
  else if (type === "O") score += 5;
  else if (type === "C") score += 2;

  if (desc.includes("closed")) score += 6;
  if (desc.includes("all main lanes closed")) score += 8;
  if (desc.includes("bridge is closed")) score += 8;
  if (desc.includes("damage")) score += 6;
  if (desc.includes("flood")) score += 8;
  if (desc.includes("use alternate route")) score += 4;
  if (desc.includes("detour")) score += 4;
  if (desc.includes("travel discouraged")) score += 5;
  if (desc.includes("main lanes not affected")) score -= 3;
  if (desc.includes("frontage road only")) score -= 2;

  return Math.max(0, Math.min(20, score));
}

async function fetchTile(host, z, x, y) {
  const url = `${host}/${TILESET_PATH}/${z}/${x}/${y}.grid.json`;

  const res = await fetch(url, {
    headers: { accept: "application/json,*/*" }
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  return res.json();
}

async function main() {
  const eventsById = new Map();
  let requests = 0;
  let successes = 0;
  let failures = 0;

  for (let x = X_MIN; x <= X_MAX; x++) {
    for (let y = Y_MIN; y <= Y_MAX; y++) {
      let tile = null;

      for (const host of DRIVETEXAS_HOSTS) {
        try {
          requests++;
          tile = await fetchTile(host, Z, x, y);
          successes++;
          break;
        } catch (err) {
          failures++;
        }
      }

      if (!tile || !tile.grid || !tile.keys || !tile.data) continue;

      const seenKeysInTile = new Set();

      tile.grid.forEach((row, rowIndex) => {
        [...row].forEach((symbol, colIndex) => {
          if (!symbol || symbol === " ") return;

          const keyIndex = symbol.charCodeAt(0) - 32;
          const eventId = tile.keys[keyIndex];

          if (!eventId || seenKeysInTile.has(eventId)) return;
          seenKeysInTile.add(eventId);

          const raw = tile.data[eventId];
          if (!raw) return;

          const { lat, lon } = tileCellToLatLon(
            Z,
            x,
            y,
            colIndex,
            rowIndex,
            tile.grid.length || 64
          );

          const event = {
            id: eventId,
            lat,
            lon,
            type: raw.CNSTRNT_TYPE_CD || "Unknown",
            road: raw.RDWAY_NM || raw.RTE_NM || "Unknown",
            route: raw.RTE_NM || "",
            direction: raw.TRVL_DRCT_CD || "",
            description: cleanRoadText(raw.COND_DSCR),
            endTime: raw.COND_END_TS ? new Date(raw.COND_END_TS).toISOString() : null,
            source: "DriveTexas UTFGrid tile"
          };

          event.risk = roadRiskScore(event);

          eventsById.set(event.id, event);
        });
      });
    }
  }

  const events = [...eventsById.values()].sort((a, b) => b.risk - a.risk);

  console.log(JSON.stringify({
    updated: new Date().toISOString(),
    requests,
    successes,
    failures,
    count: events.length,
    topEvents: events.slice(0, 25)
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
