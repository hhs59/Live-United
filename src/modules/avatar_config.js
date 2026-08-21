/**
 * Provider-owned single-image avatar configuration.
 *
 * This module deliberately has no dependency on the Gemini session. An avatar
 * can be replaced without changing the voice client or Python backend.
 */

export const AVATAR_MANIFEST_URL = 'assets/avatar/avatar.json';
export const AVATAR_PREPARATION_CACHE_KEY = 'avatar_preparation_v1';
export const AVATAR_MANIFEST_VERSION = 1;
export const AVATAR_RIG_VERSION = 4;
export const AVATAR_ANALYSIS_VERSION = 2;
export const AVATAR_PREPARATION_VERSION = 1;
export const MAX_AUTOMATIC_AVATAR_IMAGE_BYTES = 8 * 1024 * 1024;
export const MIN_AUTOMATIC_AVATAR_IMAGE_SIDE = 512;

const DEFAULT_VIEW = Object.freeze({
  fit: 'cover',
  positionX: 0.5,
  positionY: 0.5,
  zoom: 1,
});
const ALLOWED_FITS = new Set(['cover', 'contain']);
const ALLOWED_MOUTH_MODES = new Set(['auto', 'manual']);
const ALLOWED_STYLES = new Set(['cartoon', 'minimal', 'soft']);
const ALLOWED_MOTION_MODES = new Set(['off', 'auto', 'mesh']);
const ALLOWED_MOTION_PRESETS = new Set(['subtle-v1']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function freezeObject(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeObject(child);
  return Object.freeze(value);
}

function getPageBaseUrl(baseUrl) {
  if (baseUrl) return new URL(baseUrl, 'http://localhost/');
  if (typeof window !== 'undefined' && window.location?.href) {
    return new URL(window.location.href);
  }
  return new URL('http://localhost/');
}

function getLocalMotionOverride(pageUrl) {
  const hostname = String(pageUrl?.hostname || '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) return null;
  const requested = pageUrl?.searchParams?.get('avatarMotion')?.toLowerCase();
  return requested === 'auto' || requested === 'mesh' || requested === 'off' ? requested : null;
}

function resolveSameOriginUrl(source, baseUrl, fieldName) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new TypeError(`Avatar ${fieldName} must be a non-empty path.`);
  }

  const pageUrl = getPageBaseUrl(baseUrl);
  let resolved;
  try {
    resolved = new URL(source.trim(), pageUrl);
  } catch (_) {
    throw new TypeError(`Avatar ${fieldName} is not a valid URL.`);
  }

  if (resolved.origin !== pageUrl.origin) {
    throw new TypeError(`Avatar ${fieldName} must use the frontend origin.`);
  }

  if (!['http:', 'https:'].includes(resolved.protocol)) {
    throw new TypeError(`Avatar ${fieldName} must use HTTP or HTTPS.`);
  }

  return resolved;
}

function normalizeColor(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !HEX_COLOR.test(value.trim())) {
    throw new TypeError(`Avatar ${fieldName} must be a six-digit hex color.`);
  }
  return value.trim().toLowerCase();
}

function normalizeUnit(value, fallback, fieldName) {
  if (value === undefined || value === null) return fallback;
  const numericValue = asFiniteNumber(value);
  if (numericValue === null || numericValue < 0 || numericValue > 1) {
    throw new RangeError(`Avatar ${fieldName} must be between 0 and 1.`);
  }
  return numericValue;
}

function normalizeZoom(value, fallback = DEFAULT_VIEW.zoom) {
  if (value === undefined || value === null) return fallback;
  const numericValue = asFiniteNumber(value);
  if (numericValue === null || numericValue < 0.5 || numericValue > 2) {
    throw new RangeError('Avatar view.zoom must be between 0.5 and 2.');
  }
  return numericValue;
}

function normalizeView(value, legacyFit) {
  if (value !== undefined && value !== null &&
      (typeof value !== 'object' || Array.isArray(value))) {
    throw new TypeError('Avatar view must be an object.');
  }

  const source = value || {};
  const fitValue = source.fit ?? legacyFit ?? DEFAULT_VIEW.fit;
  const fit = String(fitValue).toLowerCase();
  if (!ALLOWED_FITS.has(fit)) throw new TypeError(`Unsupported avatar fit: ${fit}.`);

  return {
    fit,
    positionX: normalizeUnit(source.positionX, DEFAULT_VIEW.positionX, 'view.positionX'),
    positionY: normalizeUnit(source.positionY, DEFAULT_VIEW.positionY, 'view.positionY'),
    zoom: normalizeZoom(source.zoom),
  };
}

function normalizeRigBox(value) {
  if (value === undefined || value === null ||
      !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = asFiniteNumber(value.x);
  const y = asFiniteNumber(value.y);
  const width = asFiniteNumber(value.width);
  const height = asFiniteNumber(value.height);
  if ([x, y, width, height].some((item) => item === null) ||
      width <= 0 || height <= 0 || width > 1 || height > 1 ||
      x - width / 2 < 0 || x + width / 2 > 1 ||
      y - height / 2 < 0 || y + height / 2 > 1) return null;
  return { x, y, width, height };
}

function rigBoxContains(outer, inner, tolerance) {
  const outerLeft = outer.x - outer.width / 2;
  const outerTop = outer.y - outer.height / 2;
  const outerRight = outer.x + outer.width / 2;
  const outerBottom = outer.y + outer.height / 2;
  const innerLeft = inner.x - inner.width / 2;
  const innerTop = inner.y - inner.height / 2;
  const innerRight = inner.x + inner.width / 2;
  const innerBottom = inner.y + inner.height / 2;
  return innerLeft >= outerLeft - tolerance &&
    innerTop >= outerTop - tolerance &&
    innerRight <= outerRight + tolerance &&
    innerBottom <= outerBottom + tolerance;
}

function normalizeRigScalar(value, minimum = 0, maximum = 1) {
  const number = asFiniteNumber(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function normalizeRigPoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = asFiniteNumber(value.x);
  const y = asFiniteNumber(value.y);
  if ([x, y].some((item) => item === null) || x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}

function normalizeMotion(value, baseUrl, modeOverride = null) {
  if (value === undefined || value === null) {
    return {
      mode: 'off',
      rig: null,
      rigUrl: null,
      preset: 'subtle-v1',
      intensity: 1,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Avatar motion must be an object.');
  }

  const mode = modeOverride || String(value.mode || 'off').toLowerCase();
  if (!ALLOWED_MOTION_MODES.has(mode)) {
    throw new TypeError(`Unsupported avatar motion mode: ${mode}.`);
  }
  const preset = String(value.preset || 'subtle-v1').toLowerCase();
  if (!ALLOWED_MOTION_PRESETS.has(preset)) {
    throw new TypeError(`Unsupported avatar motion preset: ${preset}.`);
  }
  const rawIntensity = value.intensity === undefined ? 1 : asFiniteNumber(value.intensity);
  if (rawIntensity === null || rawIntensity < 0.5 || rawIntensity > 1.25) {
    throw new RangeError('Avatar motion.intensity must be between 0.5 and 1.25.');
  }
  if (mode === 'off') {
    return { mode, rig: null, rigUrl: null, preset, intensity: rawIntensity };
  }
  if (mode === 'auto') {
    if (!modeOverride && value.rig !== undefined && value.rig !== null) {
      throw new TypeError('Avatar motion.rig is not allowed when motion.mode is auto.');
    }
    return { mode, rig: null, rigUrl: null, preset, intensity: rawIntensity };
  }
  const rigUrl = resolveSameOriginUrl(value.rig, baseUrl, 'motion.rig');
  return {
    mode,
    rig: rigUrl.pathname + rigUrl.search + rigUrl.hash,
    rigUrl: rigUrl.href,
    preset,
    intensity: rawIntensity,
  };
}

/**
 * Validate and normalize a normalized source-image mouth box.
 * Manual boxes are rejected when they extend beyond the source image rather
 * than being silently moved to a different character feature.
 */
export function normalizeMouthBox(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Avatar mouth.box must be an object.');
  }

  const x = asFiniteNumber(value.x);
  const y = asFiniteNumber(value.y);
  const width = asFiniteNumber(value.width);
  const height = asFiniteNumber(value.height);

  if ([x, y, width, height].some((item) => item === null)) {
    throw new TypeError('Avatar mouth.box values must be finite numbers.');
  }
  if (width <= 0 || height <= 0 || width > 1 || height > 1) {
    throw new RangeError('Avatar mouth.box width and height must be in (0, 1].');
  }
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    throw new RangeError('Avatar mouth.box center must be inside the image.');
  }
  if (x - width / 2 < 0 || x + width / 2 > 1 ||
      y - height / 2 < 0 || y + height / 2 > 1) {
    throw new RangeError('Avatar mouth.box must fit inside the image.');
  }

  return { x, y, width, height };
}

function normalizeColors(colors) {
  if (colors === undefined || colors === null) return {};
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
    throw new TypeError('Avatar mouth.colors must be an object.');
  }

  const normalized = {};
  for (const field of ['cover', 'lip', 'inner', 'tongue', 'teeth']) {
    const color = normalizeColor(colors[field], `mouth.colors.${field}`);
    if (color) normalized[field] = color;
  }
  return normalized;
}

/**
 * Normalize the provider manifest. `baseUrl` is the frontend page URL, not
 * the manifest directory; image paths are intentionally site-root-relative
 * from the provider's perspective (`assets/avatar/...`).
 */
export function normalizeAvatarManifest(value, baseUrl) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Avatar manifest must be a JSON object.');
  }
  if (value.version !== AVATAR_MANIFEST_VERSION) {
    throw new RangeError(`Avatar manifest version must be ${AVATAR_MANIFEST_VERSION}.`);
  }

  const pageUrl = getPageBaseUrl(baseUrl);
  const imageUrl = resolveSameOriginUrl(value.image, pageUrl, 'image');
  const view = normalizeView(value.view, value.fit);
  const viewSource = value.view && typeof value.view === 'object' ? value.view : {};
  const viewOverrides = {
    fit: Object.prototype.hasOwnProperty.call(viewSource, 'fit') || value.fit !== undefined,
    positionX: Object.prototype.hasOwnProperty.call(viewSource, 'positionX'),
    positionY: Object.prototype.hasOwnProperty.call(viewSource, 'positionY'),
    zoom: Object.prototype.hasOwnProperty.call(viewSource, 'zoom'),
  };

  if (value.mouth !== undefined && value.mouth !== null &&
      (typeof value.mouth !== 'object' || Array.isArray(value.mouth))) {
    throw new TypeError('Avatar mouth must be an object.');
  }

  const mouthSource = value.mouth || {};
  const box = normalizeMouthBox(mouthSource.box);
  const requestedMode = mouthSource.mode === undefined
    ? 'auto'
    : String(mouthSource.mode).toLowerCase();
  if (!ALLOWED_MOUTH_MODES.has(requestedMode)) {
    throw new TypeError(`Unsupported avatar mouth mode: ${requestedMode}.`);
  }
  if (requestedMode === 'manual' && !box) {
    throw new TypeError('Avatar mouth.box is required when mouth.mode is manual.');
  }

  const style = mouthSource.style === undefined
    ? 'cartoon'
    : String(mouthSource.style).toLowerCase();
  if (!ALLOWED_STYLES.has(style)) {
    throw new TypeError(`Unsupported avatar mouth style: ${style}.`);
  }

  // A mesh preview can be enabled explicitly on local development hosts
  // without changing the checked-in production manifest default.
  const motion = normalizeMotion(value.motion, pageUrl, getLocalMotionOverride(pageUrl));

  const normalized = {
    version: AVATAR_MANIFEST_VERSION,
    image: imageUrl.pathname + imageUrl.search + imageUrl.hash,
    imageUrl: imageUrl.href,
    // Keep the normalized root field for existing callers while making view
    // the authoritative framing contract.
    fit: view.fit,
    view,
    viewOverrides,
    mouth: {
      // A valid box is authoritative, regardless of a stale mode value.
      mode: box ? 'manual' : requestedMode,
      box,
      style,
      colors: normalizeColors(mouthSource.colors),
    },
    motion,
  };

  return freezeObject(normalized);
}

function getStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (_) {
    return null;
  }
}

function isSha256(value) {
  return typeof value === 'string' && SHA256.test(value.trim().toLowerCase());
}

function normalizePreparationEntry(value, sourceHash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalizedHash = String(sourceHash || '').trim().toLowerCase();
  if (!isSha256(normalizedHash) ||
      value.version !== AVATAR_PREPARATION_VERSION ||
      value.analysisVersion !== AVATAR_ANALYSIS_VERSION ||
      String(value.sourceHash || '').trim().toLowerCase() !== normalizedHash ||
      !value.geometry || typeof value.geometry !== 'object' || Array.isArray(value.geometry)) {
    return null;
  }
  return {
    version: AVATAR_PREPARATION_VERSION,
    analysisVersion: AVATAR_ANALYSIS_VERSION,
    sourceHash: normalizedHash,
    geometry: value.geometry,
  };
}

/** Read the one-entry browser cache; renderer validation remains authoritative. */
export function readCachedAvatarPreparation(sourceHash) {
  const storage = getStorage();
  if (!storage || !isSha256(sourceHash)) return null;
  try {
    return normalizePreparationEntry(
      JSON.parse(storage.getItem(AVATAR_PREPARATION_CACHE_KEY) || 'null'),
      sourceHash,
    );
  } catch (_) {
    return null;
  }
}

export function writeCachedAvatarPreparation(sourceHash, geometry) {
  const storage = getStorage();
  if (!storage || !isSha256(sourceHash) ||
      !geometry || typeof geometry !== 'object' || Array.isArray(geometry)) return false;
  const entry = normalizePreparationEntry({
    version: AVATAR_PREPARATION_VERSION,
    analysisVersion: AVATAR_ANALYSIS_VERSION,
    sourceHash,
    geometry,
  }, sourceHash);
  if (!entry) return false;
  try {
    storage.setItem(AVATAR_PREPARATION_CACHE_KEY, JSON.stringify(entry));
    return true;
  } catch (_) {
    return false;
  }
}

/** Validate a generated one-image body rig before it reaches WebGL. */
export function normalizeMeshRig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Number(value.rigVersion) !== AVATAR_RIG_VERSION ||
      Number(value.analysisVersion) !== AVATAR_ANALYSIS_VERSION) return null;

  const sourceHash = typeof value.sourceHash === 'string'
    ? value.sourceHash.trim().toLowerCase()
    : '';
  if (!SHA256.test(sourceHash)) return null;

  const sourceWidth = Number(value.sourceWidth);
  const sourceHeight = Number(value.sourceHeight);
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) ||
      sourceWidth < 1 || sourceHeight < 1) return null;

  const characterBox = normalizeRigBox(value.characterBox);
  const headBox = normalizeRigBox(value.headBox);
  const torsoBox = normalizeRigBox(value.torsoBox);
  const neckPoint = normalizeRigPoint(value.neckPoint);
  const rootPoint = normalizeRigPoint(value.rootPoint);
  if (!characterBox || !headBox || !torsoBox || !neckPoint || !rootPoint) return null;
  if (value.singleCharacter !== true) return null;
  if (headBox.width < 0.08 || headBox.height < 0.08 ||
      torsoBox.width < 0.08 || torsoBox.height < 0.08 ||
      headBox.y >= torsoBox.y) return null;
  const bodyTolerance = Math.max(0.03, characterBox.width * 0.08);
  if (!rigBoxContains(characterBox, headBox, bodyTolerance) ||
      !rigBoxContains(characterBox, torsoBox, bodyTolerance)) return null;

  const mesh = value.mesh && typeof value.mesh === 'object' ? value.mesh : {};
  const columns = Number(mesh.columns ?? 13);
  const rows = Number(mesh.rows ?? 13);
  if (columns !== 13 || rows !== 13) return null;

  const confidence = normalizeRigScalar(value.confidence, 0, 1);
  if (confidence === null || confidence < 0.65) return null;
  const orientation = String(value.orientation || '').toLowerCase();
  if (!['frontal', 'near_frontal'].includes(orientation)) return null;

  const headEdges = {
    bottom: headBox.y + headBox.height / 2,
  };
  const torsoEdges = {
    top: torsoBox.y - torsoBox.height / 2,
  };
  if (neckPoint.y < headEdges.bottom - 0.12 ||
      neckPoint.y > headEdges.bottom + 0.14 ||
      neckPoint.y < torsoEdges.top - 0.18 ||
      neckPoint.y > torsoEdges.top + 0.14 ||
      rootPoint.y < characterBox.y ||
      Math.abs(rootPoint.x - characterBox.x) > characterBox.width * 0.45) return null;

  const optionalBox = (field) => value[field] === null || value[field] === undefined
    ? null
    : normalizeRigBox(value[field]);
  const faceBox = optionalBox('faceBox');
  const mouthBox = optionalBox('mouthBox');
  if ((value.faceBox !== undefined && value.faceBox !== null && !faceBox) ||
      (value.mouthBox !== undefined && value.mouthBox !== null && !mouthBox)) return null;

  return freezeObject({
    rigVersion: AVATAR_RIG_VERSION,
    analysisVersion: AVATAR_ANALYSIS_VERSION,
    sourceHash,
    sourceWidth,
    sourceHeight,
    source: typeof value.source === 'string' ? value.source : 'generated',
    analyzerModel: typeof value.analyzerModel === 'string' ? value.analyzerModel : null,
    confidence,
    orientation,
    singleCharacter: value.singleCharacter === true,
    characterBox,
    headBox,
    torsoBox,
    neckPoint,
    rootPoint,
    faceBox,
    mouthBox,
    mesh: { columns: 13, rows: 13 },
    motionPreset: ALLOWED_MOTION_PRESETS.has(String(value.motionPreset || '').toLowerCase())
      ? String(value.motionPreset).toLowerCase()
      : 'subtle-v1',
  });
}

/**
 * Convert validated canonical body geometry into the runtime mesh contract.
 * The model never supplies vertices or motion curves; avatar_mesh.js creates
 * those deterministically from these normalized regions.
 */
export function createMeshRigFromGeometry(definition = {}, meshGeometry = {}) {
  const sourceHash = typeof definition.imageHash === 'string'
    ? definition.imageHash.trim().toLowerCase()
    : '';
  const sourceWidth = Number(definition.sourceWidth);
  const sourceHeight = Number(definition.sourceHeight);
  if (!isSha256(sourceHash) || !Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) ||
      sourceWidth < 1 || sourceHeight < 1 || !meshGeometry || typeof meshGeometry !== 'object') {
    return null;
  }

  return normalizeMeshRig({
    rigVersion: AVATAR_RIG_VERSION,
    analysisVersion: AVATAR_ANALYSIS_VERSION,
    sourceHash,
    sourceWidth,
    sourceHeight,
    source: 'gemini-vision-auto',
    analyzerModel: meshGeometry.model,
    confidence: meshGeometry.confidence,
    orientation: meshGeometry.orientation,
    singleCharacter: meshGeometry.singleCharacter,
    characterBox: meshGeometry.characterBox,
    headBox: meshGeometry.headBox,
    torsoBox: meshGeometry.torsoBox,
    neckPoint: meshGeometry.neckPoint,
    rootPoint: meshGeometry.rootPoint,
    faceBox: meshGeometry.faceBox || null,
    mouthBox: meshGeometry.mouthBox || null,
    mesh: { columns: 13, rows: 13 },
    motionPreset: definition.motionPreset || 'subtle-v1',
  });
}

export async function loadAvatarRig(definition) {
  const motion = definition?.manifest?.motion;
  if (!motion || motion.mode !== 'mesh') return null;
  if (!motion.rigUrl) throw new Error('Avatar mesh motion requires motion.rig.');

  const response = await fetch(motion.rigUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Avatar mesh rig request failed (${response.status}).`);
  const rig = normalizeMeshRig(await response.json());
  if (!rig) throw new Error('Avatar mesh rig is invalid or outdated.');
  if (rig.sourceHash !== definition.imageHash ||
      rig.sourceWidth !== definition.sourceWidth || rig.sourceHeight !== definition.sourceHeight) {
    throw new Error('Avatar mesh rig does not match the provider image.');
  }
  return rig;
}

async function hashBytes(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeImage(bytes, contentType, imageUrl) {
  if (typeof Image === 'undefined' || typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function') {
    throw new Error('Browser image decoding is unavailable.');
  }

  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes], {
      type: contentType || (imageUrl.endsWith('.jpg') || imageUrl.endsWith('.jpeg')
        ? 'image/jpeg'
        : 'image/png'),
    });
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Avatar image could not be decoded: ${imageUrl}`));
    };
    image.src = objectUrl;
  });
}

function normalizeImageMimeType(value, imageUrl) {
  const declared = typeof value === 'string'
    ? value.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (declared === 'image/png' || declared === 'image/jpeg') return declared;
  const lowerUrl = String(imageUrl || '').toLowerCase();
  if (lowerUrl.includes('.png')) return 'image/png';
  if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg')) return 'image/jpeg';
  return '';
}

/**
 * Load the provider manifest and image. The manifest is intentionally fetched
 * with revalidation so changing an image without changing its filename is
 * noticed during local development.
 */
export async function loadAvatarDefinition(options = {}) {
  const manifestUrl = options.manifestUrl || AVATAR_MANIFEST_URL;
  const pageBaseUrl = options.baseUrl || (
    typeof window !== 'undefined' ? window.location.href : 'http://localhost/index.html'
  );
  const manifestResponse = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!manifestResponse.ok) {
    throw new Error(`Avatar manifest request failed (${manifestResponse.status}).`);
  }

  const rawManifest = await manifestResponse.json();
  const manifest = normalizeAvatarManifest(rawManifest, pageBaseUrl);
  const imageResponse = await fetch(manifest.imageUrl, { cache: 'no-cache' });
  if (!imageResponse.ok) {
    throw new Error(`Avatar image request failed (${imageResponse.status}).`);
  }

  const bytes = await imageResponse.arrayBuffer();
  if (!bytes.byteLength) throw new Error('Avatar image is empty.');
  const mimeType = normalizeImageMimeType(
    imageResponse.headers?.get?.('content-type'),
    manifest.imageUrl,
  );
  if (!mimeType) throw new Error('Avatar image must be PNG or JPEG.');
  if (bytes.byteLength > MAX_AUTOMATIC_AVATAR_IMAGE_BYTES) {
    throw new Error('Automatic avatar preparation supports images up to 8 MiB.');
  }
  const imageHash = await hashBytes(bytes);
  const image = await decodeImage(
    bytes,
    mimeType,
    manifest.imageUrl,
  );

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!(sourceWidth > 0 && sourceHeight > 0)) {
    throw new Error('Avatar image has invalid dimensions.');
  }

  const automaticEligible = Math.min(sourceWidth, sourceHeight) >= MIN_AUTOMATIC_AVATAR_IMAGE_SIDE;

  return {
    manifest,
    image,
    imageUrl: manifest.imageUrl,
    imageHash,
    imageBytes: bytes,
    mimeType,
    sourceWidth,
    sourceHeight,
    automaticEligible,
  };
}
