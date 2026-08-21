/** Resolve the local/backend origin shared by voice and avatar setup calls. */
export function getBackendUrl(path) {
  const configuredOrigin = typeof window !== 'undefined'
    ? window.UNI_BACKEND_URL
    : '';
  const fallbackOrigin = typeof window !== 'undefined' && window.location?.hostname
    ? `${window.location.protocol}//${window.location.hostname}:3000`
    : 'http://localhost:3000';
  const origin = typeof configuredOrigin === 'string' && configuredOrigin.trim()
    ? configuredOrigin.trim()
    : fallbackOrigin;

  const normalizedPath = String(path || '').startsWith('/')
    ? String(path)
    : `/${String(path || '')}`;
  return origin.replace(/\/$/, '') + normalizedPath;
}
