/**
 * Ejar never sends a city — only `region` (e.g. eastern_province) and the
 * property's `latitude` / `longitude`. The region alone only matched a city
 * when both share a key (riyadh); everywhere else the import asked for the
 * city. This table holds an approximate centre for each `lookups` city key, so
 * the import can pick the nearest one from Ejar's coordinates.
 *
 * Keys must match `lookups.key` (category `city`). A city missing here just
 * can't be picked by coordinates; nothing else changes.
 */
export const CITY_COORDS: Record<string, readonly [lat: number, lng: number]> = {
  // Riyadh region
  riyadh: [24.7136, 46.6753],
  al_kharj: [24.1556, 47.3346],
  al_majmaah: [25.9039, 45.3456],
  ad_dawadimi: [24.507, 44.3924],
  az_zulfi: [26.2994, 44.8154],
  al_quwayiyah: [24.0737, 45.2806],
  wadi_al_dawasir: [20.4607, 44.7826],
  al_aflaj: [22.2919, 46.7253],
  shaqra: [25.2494, 45.2531],
  dharma: [24.6031, 46.1206],
  al_hariq: [23.6227, 46.5162],
  marat: [25.0707, 45.461],
  // Makkah region
  jeddah: [21.4858, 39.1925],
  makkah: [21.3891, 39.8579],
  ta_if: [21.2703, 40.4158],
  rabigh: [22.7986, 39.0349],
  al_qunfudhah: [19.1281, 41.0787],
  al_layth: [20.15, 40.2667],
  khulayyis: [22.15, 39.3167],
  al_jumum: [21.6167, 39.7],
  bahra: [21.4, 39.45],
  // Eastern region
  dammam: [26.4207, 50.0888],
  al_khobar: [26.2172, 50.1971],
  al_ahsa: [25.3647, 49.5856],
  al_jubail: [27.0046, 49.646],
  al_qatif: [26.556, 50.009],
  hafar_al_batin: [28.4328, 45.9708],
  dhahran: [26.2361, 50.0393],
  al_khafji: [28.4392, 48.4913],
  buqayq: [25.934, 49.668],
  ras_tanura: [26.6436, 50.1597],
  an_nuayriyah: [27.47, 48.49],
  // Madinah region
  madinah: [24.5247, 39.5692],
  yanbu: [24.0895, 38.0618],
  alula: [26.6085, 37.9232],
  al_wajh: [26.2455, 36.4525],
  badr: [23.78, 38.79],
  al_mahd: [23.5, 40.86],
  khaybar: [25.697, 39.292],
  // Asir region
  abha: [18.2164, 42.5053],
  khamis_mushait: [18.306, 42.729],
  bisha: [20.0005, 42.6052],
  an_namas: [19.12, 42.13],
  muhayil_asir: [18.545, 42.05],
  sarat_abidah: [18.1, 43.13],
  rijal_alma: [18.21, 42.27],
  al_majardah: [19.12, 41.91],
  // Tabuk region
  tabuk: [28.3835, 36.5662],
  duba: [27.351, 35.69],
  haql: [29.289, 34.937],
  umluj: [25.021, 37.268],
  tayma: [27.63, 38.55],
  al_bad: [28.48, 35.0],
  // Qassim region
  buraydah: [26.326, 43.975],
  unayzah: [26.084, 43.993],
  ar_rass: [25.869, 43.497],
  al_bukayriyah: [26.139, 43.659],
  al_mudhnib: [25.86, 44.22],
  ash_shmasiyah: [26.32, 44.26],
  uyun_al_jawaa: [26.52, 43.68],
  // Hail region
  ha_il: [27.5114, 41.7208],
  baqa: [27.89, 42.42],
  al_ghazalah: [26.77, 41.32],
  ash_shannan: [27.18, 42.44],
  al_hayt: [25.99, 40.47],
  // Jazan region
  jizan: [16.8892, 42.5511],
  sabya: [17.15, 42.625],
  abu_arish: [16.969, 42.832],
  ad_darb: [17.725, 42.255],
  samtah: [16.596, 42.944],
  baysh: [17.38, 42.54],
  damad: [17.09, 42.78],
  ar_rayth: [17.62, 42.93],
  farasan: [16.702, 42.118],
  // Najran region
  najran: [17.4924, 44.1277],
  sharorah: [17.49, 47.11],
  habuna: [17.84, 44.04],
  badr_al_janoub: [17.85, 43.74],
  yadamah: [18.55, 44.23],
  // Al-Bahah region
  al_bahah: [20.0129, 41.4677],
  baljurashi: [19.859, 41.559],
  al_mandiq: [20.1, 41.28],
  al_aqiq: [20.27, 41.65],
  qilwah: [19.93, 41.15],
  al_mikhwah: [19.78, 41.43],
  // Northern Borders region
  arar: [30.9753, 41.0381],
  rafha: [29.626, 43.493],
  turaif: [31.672, 38.664],
  al_uwayqilah: [30.34, 42.25],
  // Al-Jawf region
  sakaka: [29.9697, 40.2064],
  al_qurayyat: [31.3317, 37.3428],
  dawmat_al_jandal: [29.811, 39.868],
};

/** Farther than this from every listed city → no guess; the user picks. */
export const NEAREST_CITY_MAX_KM = 50;

function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The city key nearest to Ejar's coordinates, or null when none is within range. */
export function nearestCityKey(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  let best: string | null = null;
  let bestKm = Infinity;
  for (const [key, [cLat, cLng]] of Object.entries(CITY_COORDS)) {
    const d = km(lat, lng, cLat, cLng);
    if (d < bestKm) { bestKm = d; best = key; }
  }
  return bestKm <= NEAREST_CITY_MAX_KM ? best : null;
}
