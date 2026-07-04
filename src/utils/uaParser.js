/**
 * Minimal user-agent parser for analytics (device class, browser, OS).
 * Deliberately coarse — dashboard breakdowns don't need full UA fidelity.
 */
function parseUserAgent(ua) {
  const s = String(ua || '');

  const isTablet = /iPad|Tablet|Nexus (7|9|10)|SM-T|Kindle|Silk/i.test(s);
  const isMobile = !isTablet && /Mobi|iPhone|iPod|Windows Phone|Android/i.test(s);
  const deviceType = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';

  let browser = 'Other';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
  else if (/Chrome\/|CriOS/.test(s)) browser = 'Chrome';
  else if (/Firefox\/|FxiOS/.test(s)) browser = 'Firefox';
  else if (/Safari\//.test(s)) browser = 'Safari';

  let os = 'Other';
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';

  return { deviceType, browser, os };
}

module.exports = { parseUserAgent };
