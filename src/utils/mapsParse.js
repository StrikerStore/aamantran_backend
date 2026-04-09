/** @returns {{ lat: number, lng: number } | null} */
function parseGoogleMapsLocation(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  const comma = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(s.replace(/\s/g, ' ').trim());
  if (comma) {
    const lat = parseFloat(comma[1]);
    const lng = parseFloat(comma[2]);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }

  const at = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/.exec(s);
  if (at) {
    const lat = parseFloat(at[1]);
    const lng = parseFloat(at[2]);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }

  const bang = /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/.exec(s);
  if (bang) {
    const lat = parseFloat(bang[1]);
    const lng = parseFloat(bang[2]);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }

  const qEq = /[?&]q=(-?\d+\.?\d*)[+,](-?\d+\.?\d*)/i.exec(s);
  if (qEq) {
    const lat = parseFloat(qEq[1]);
    const lng = parseFloat(qEq[2]);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }

  return null;
}

function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

module.exports = { parseGoogleMapsLocation, isValidLatLng };
