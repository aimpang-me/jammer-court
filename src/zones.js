// The one list of zones. Order matters: when an aircraft shows up in two responses in one tick,
// the first response that contained it decides its position (spec 3.1). Adding a zone means one
// object here, then `npm run gen-cells` so the gpsjam comparison knows its cells.
// Sentinels other than the Baltic are placed from public interference reports (inferred).
const S = "sentinel";
const C = "control";

export const ZONES = Object.freeze(
  [
    { id: "baltic", name: "Baltic (Gotland to Kaliningrad)", lat: 57.0, lon: 20.0, r_nm: 250, role: S, min_n: 8 },
    { id: "gulf_finland", name: "Gulf of Finland", lat: 60.0, lon: 25.5, r_nm: 110, role: S, min_n: 6 },
    { id: "vilnius", name: "Vilnius and Belarus border", lat: 54.7, lon: 25.3, r_nm: 100, role: S, min_n: 6 },
    { id: "finnmark", name: "Finnmark and Kola border", lat: 70.0, lon: 28.0, r_nm: 150, role: S, min_n: 4 },
    { id: "black_sea", name: "Western Black Sea", lat: 43.5, lon: 30.0, r_nm: 200, role: S, min_n: 5 },
    { id: "caucasus", name: "South Caucasus", lat: 41.5, lon: 44.5, r_nm: 200, role: S, min_n: 5 },
    { id: "levant", name: "Eastern Mediterranean and Levant", lat: 33.5, lon: 35.0, r_nm: 200, role: S, min_n: 6 },
    { id: "sinai", name: "Sinai and northern Red Sea", lat: 28.5, lon: 34.0, r_nm: 150, role: S, min_n: 5 },
    { id: "iraq", name: "Baghdad and Kuwait corridor", lat: 33.0, lon: 44.0, r_nm: 150, role: S, min_n: 5 },
    { id: "gulf", name: "Persian Gulf and Hormuz", lat: 26.5, lon: 54.5, r_nm: 200, role: S, min_n: 6 },
    { id: "punjab", name: "Punjab border", lat: 31.5, lon: 74.5, r_nm: 150, role: S, min_n: 5 },
    { id: "central_med", name: "Central Mediterranean (Malta and Libya)", lat: 34.0, lon: 15.0, r_nm: 200, role: S, min_n: 5 },
    { id: "ctl_london", name: "London", lat: 51.5, lon: -0.5, r_nm: 100, role: C, min_n: 10 },
    { id: "ctl_frankfurt", name: "Frankfurt", lat: 50.0, lon: 8.6, r_nm: 100, role: C, min_n: 10 },
    { id: "ctl_madrid", name: "Madrid", lat: 40.5, lon: -3.6, r_nm: 100, role: C, min_n: 10 },
    { id: "ctl_atlanta", name: "Atlanta", lat: 33.6, lon: -84.4, r_nm: 100, role: C, min_n: 10 },
    { id: "ctl_chicago", name: "Chicago", lat: 42.0, lon: -87.9, r_nm: 100, role: C, min_n: 10 },
    { id: "ctl_dallas", name: "Dallas", lat: 32.9, lon: -97.0, r_nm: 100, role: C, min_n: 10 },
    { id: "ctl_tokyo", name: "Tokyo", lat: 35.5, lon: 139.8, r_nm: 100, role: C, min_n: 8 },
    { id: "ctl_sydney", name: "Sydney", lat: -33.9, lon: 151.2, r_nm: 100, role: C, min_n: 8 },
  ].map(Object.freeze),
);

export const ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));
