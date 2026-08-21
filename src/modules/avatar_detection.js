/**
 * One-time vision analysis and deterministic safe-mouth geometry.
 *
 * The backend asks a vision model to locate the primary face and facial
 * regions once per uncached provider image. This module validates that result
 * and turns it into a conservative renderer rig. It does not run in the
 * Gemini Live audio path and it never lets model output choose Canvas pixels
 * without local bounds checks.
 */

import { getBackendUrl } from './backend_api.js';
import { AVATAR_PREPARATION_VERSION } from './avatar_config.js';

export const AVATAR_ANALYSIS_VERSION = 2;
export const AVATAR_ANALYSIS_MAX_BYTES = 8 * 1024 * 1024;
export const ALLOWED_AVATAR_IMAGE_TYPES = Object.freeze(new Set([
  'image/png',
  'image/jpeg',
]));

const ALLOWED_ORIENTATIONS = new Set(['frontal', 'near_frontal']);
const DEFAULT_ANALYSIS_TIMEOUT_MS = 20_000;
const SUPPORTED_ANALYSIS_VERSIONS = new Set([1, AVATAR_ANALYSIS_VERSION]);
const SHA256 = /^[0-9a-f]{64}$/;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum = 0, maximum = 1) {
  const number = finite(value);
  if (number === null) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

function createBoxFromEdges(left, top, right, bottom) {
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (!(right > left && bottom > top)) return null;
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}

function getEdges(box) {
  if (!box) return null;
  return {
    left: box.x - box.width / 2,
    top: box.y - box.height / 2,
    right: box.x + box.width / 2,
    bottom: box.y + box.height / 2,
  };
}

function isInsideImage(box) {
  const edges = getEdges(box);
  return Boolean(
    edges &&
    edges.left >= 0 && edges.top >= 0 &&
    edges.right <= 1 && edges.bottom <= 1,
  );
}

function isInsideFace(box, face, tolerance = 0) {
  const edges = getEdges(box);
  const faceEdges = getEdges(face);
  return Boolean(
    edges && faceEdges &&
    edges.left >= faceEdges.left - tolerance &&
    edges.top >= faceEdges.top - tolerance &&
    edges.right <= faceEdges.right + tolerance &&
    edges.bottom <= faceEdges.bottom + tolerance,
  );
}

function boxesOverlap(first, second) {
  const left = getEdges(first);
  const right = getEdges(second);
  if (!left || !right) return false;
  return Math.max(left.left, right.left) < Math.min(left.right, right.right) &&
    Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom);
}

function expandBox(box, horizontalRatio, verticalRatio) {
  const edges = getEdges(box);
  if (!edges) return null;
  const horizontal = box.width * horizontalRatio;
  const vertical = box.height * verticalRatio;
  return createBoxFromEdges(
    clamp(edges.left - horizontal),
    clamp(edges.top - vertical),
    clamp(edges.right + horizontal),
    clamp(edges.bottom + vertical),
  );
}

/**
 * Normalize either the backend's center-box shape or a raw 0..1000
 * [ymin, xmin, ymax, xmax] shape into a source-image center box.
 */
export function normalizeVisionBox(value) {
  if (Array.isArray(value)) {
    if (value.length !== 4) return null;
    const values = value.map(finite);
    if (values.some((item) => item === null) ||
        values.some((item) => item < 0 || item > 1000)) return null;
    const [ymin, xmin, ymax, xmax] = values;
    if (!(ymax > ymin && xmax > xmin)) return null;
    return createBoxFromEdges(xmin / 1000, ymin / 1000, xmax / 1000, ymax / 1000);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  if ([x, y, width, height].some((item) => item === null) ||
      !(width > 0 && height > 0 && width <= 1 && height <= 1)) return null;
  const box = { x, y, width, height };
  return isInsideImage(box) ? box : null;
}

export function normalizeVisionPoint(value) {
  if (Array.isArray(value)) {
    if (value.length !== 2) return null;
    const values = value.map(finite);
    if (values.some((item) => item === null) || values.some((item) => item < 0 || item > 1000)) {
      return null;
    }
    return { x: values[1] / 1000, y: values[0] / 1000 };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  if (x === null || y === null || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function boxContains(outer, inner, tolerance) {
  const outerEdges = getEdges(outer);
  const innerEdges = getEdges(inner);
  return Boolean(
    outerEdges && innerEdges &&
    innerEdges.left >= outerEdges.left - tolerance &&
    innerEdges.top >= outerEdges.top - tolerance &&
    innerEdges.right <= outerEdges.right + tolerance &&
    innerEdges.bottom <= outerEdges.bottom + tolerance,
  );
}

/** Validate body geometry independently from the current mouth geometry. */
export function validateMeshGeometry(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.version !== undefined && !SUPPORTED_ANALYSIS_VERSIONS.has(Number(value.version))) {
    return null;
  }
  const orientation = String(value.orientation || '').toLowerCase();
  if (!ALLOWED_ORIENTATIONS.has(orientation) || value.singleCharacter !== true ||
      value.headVisible === false || value.torsoVisible === false) return null;
  const confidence = finite(value.confidence);
  if (confidence === null || confidence < 0.65 || confidence > 1) return null;

  const characterBox = normalizeVisionBox(value.characterBox || value.character_box);
  const headBox = normalizeVisionBox(value.headBox || value.head_box);
  const torsoBox = normalizeVisionBox(value.torsoBox || value.torso_box);
  const neckPoint = normalizeVisionPoint(value.neckPoint || value.neck_point);
  const rootPoint = normalizeVisionPoint(value.rootPoint || value.root_point);
  if (!characterBox || !headBox || !torsoBox || !neckPoint || !rootPoint ||
      !isInsideImage(characterBox) || !isInsideImage(headBox) || !isInsideImage(torsoBox)) {
    return null;
  }
  if (headBox.width < 0.08 || headBox.height < 0.08 ||
      torsoBox.width < 0.08 || torsoBox.height < 0.08 || headBox.y >= torsoBox.y) {
    return null;
  }
  const tolerance = Math.max(0.03, characterBox.width * 0.08);
  if (!boxContains(characterBox, headBox, tolerance) || !boxContains(characterBox, torsoBox, tolerance)) {
    return null;
  }
  const headEdges = getEdges(headBox);
  const torsoEdges = getEdges(torsoBox);
  if (Math.abs(neckPoint.x - headBox.x) > headBox.width * 0.55 ||
      neckPoint.y < headEdges.bottom - 0.18 || neckPoint.y > torsoEdges.top + 0.18) {
    return null;
  }
  const characterEdges = getEdges(characterBox);
  if (rootPoint.y < characterBox.y || rootPoint.y < characterEdges.bottom - characterBox.height * 0.55 ||
      Math.abs(rootPoint.x - characterBox.x) > characterBox.width * 0.45) return null;

  return {
    version: AVATAR_ANALYSIS_VERSION,
    source: typeof value.source === 'string' ? value.source : 'gemini-vision',
    model: typeof value.model === 'string' ? value.model : null,
    confidence,
    orientation,
    meshEligible: true,
    singleCharacter: true,
    characterBox,
    headBox,
    torsoBox,
    neckPoint,
    rootPoint,
  };
}

function normalizeOptionalBox(value, face, mouthBox, name) {
  if (value === null || value === undefined) return null;
  const box = normalizeVisionBox(value);
  if (!box || !isInsideFace(box, face, face.width * 0.08)) return null;
  if (name === 'eye' && boxesOverlap(box, mouthBox)) return null;
  return box;
}

/**
 * Validate the complete backend response. Required invalid geometry returns
 * null. Optional malformed observations are discarded so a conservative rig
 * can still be derived from a valid face and mouth.
 */
export function validateVisionGeometry(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.version !== undefined && !SUPPORTED_ANALYSIS_VERSIONS.has(Number(value.version))) {
    return null;
  }

  const orientation = String(value.orientation || '').toLowerCase();
  if (!ALLOWED_ORIENTATIONS.has(orientation)) return null;
  if (value.mouthVisible !== true || value.mouthOccluded === true) return null;

  const confidence = finite(value.confidence);
  if (confidence === null || confidence < 0.55 || confidence > 1) return null;

  const faceBox = normalizeVisionBox(value.faceBox || value.face_box);
  const mouthBox = normalizeVisionBox(value.mouthBox || value.mouth_box);
  if (!faceBox || !mouthBox || !isInsideImage(faceBox) || !isInsideImage(mouthBox)) {
    return null;
  }

  const faceEdges = getEdges(faceBox);
  const mouthEdges = getEdges(mouthBox);
  const relativeX = (mouthBox.x - faceEdges.left) / faceBox.width;
  const relativeY = (mouthBox.y - faceEdges.top) / faceBox.height;
  const widthRatio = mouthBox.width / faceBox.width;
  if (relativeX < 0.12 || relativeX > 0.88 ||
      relativeY < 0.40 || relativeY > 0.95 ||
      widthRatio < 0.03 || widthRatio > 0.80 ||
      mouthBox.height > mouthBox.width * 0.60 ||
      !isInsideFace(mouthBox, faceBox, faceBox.width * 0.08)) {
    return null;
  }

  const leftEyeBox = normalizeOptionalBox(
    value.leftEyeBox || value.left_eye_box,
    faceBox,
    mouthBox,
    'eye',
  );
  const rightEyeBox = normalizeOptionalBox(
    value.rightEyeBox || value.right_eye_box,
    faceBox,
    mouthBox,
    'eye',
  );
  let noseBox = normalizeOptionalBox(
    value.noseBox || value.nose_box,
    faceBox,
    mouthBox,
    'nose',
  );
  if (noseBox && noseBox.y >= mouthBox.y) noseBox = null;

  let chinY = finite(value.chinY ?? value.chin_y);
  if (chinY !== null && chinY > 1) chinY /= 1000;
  if (chinY === null || chinY <= mouthEdges.bottom ||
      chinY > faceEdges.bottom + faceBox.height * 0.08) {
    chinY = null;
  }

  return {
    version: AVATAR_ANALYSIS_VERSION,
    source: typeof value.source === 'string' ? value.source : 'gemini-vision',
    model: typeof value.model === 'string' ? value.model : null,
    confidence,
    orientation,
    meshEligible: Boolean(validateMeshGeometry(value)),
    mouthEligible: true,
    mouthVisible: true,
    mouthOccluded: false,
    faceBox,
    mouthBox,
    leftEyeBox,
    rightEyeBox,
    noseBox,
    chinY,
  };
}

export function deriveSuggestedView(faceBox) {
  const normalized = normalizeVisionBox(faceBox);
  if (!normalized) return null;
  return {
    positionX: clamp(normalized.x, 0.2, 0.8),
    positionY: clamp(normalized.y + normalized.height * 0.08, 0.2, 0.8),
    zoom: clamp(0.65 / normalized.height, 0.75, 1.8),
  };
}

function createSafeRegion(geometry, conservative = false) {
  const face = geometry.faceBox;
  const mouth = geometry.mouthBox;
  const faceEdges = getEdges(face);
  const mouthEdges = getEdges(mouth);
  if (!faceEdges || !mouthEdges) return null;

  const left = Math.max(0, faceEdges.left, mouthEdges.left - mouth.width * 0.35);
  const right = Math.min(1, faceEdges.right, mouthEdges.right + mouth.width * 0.35);
  if (!(right - left >= mouth.width * 1.1)) return null;

  const expandedEyes = [geometry.leftEyeBox, geometry.rightEyeBox]
    .filter(Boolean)
    .map((box) => expandBox(box, 0.08, 0.08));
  const expandedNose = geometry.noseBox
    ? expandBox(geometry.noseBox, 0.06, 0.06)
    : null;
  const eyeBottom = expandedEyes.reduce(
    (bottom, box) => Math.max(bottom, getEdges(box)?.bottom || 0),
    faceEdges.top,
  );
  const noseBottom = expandedNose ? getEdges(expandedNose).bottom : faceEdges.top;
  const upper = Math.max(
    faceEdges.top,
    mouthEdges.top - mouth.height * (conservative ? 0.30 : 0.45),
    noseBottom + face.height * (conservative ? 0.02 : 0.01),
    eyeBottom + face.height * (conservative ? 0.06 : 0.04),
  );
  if (!(upper < mouth.y)) return null;

  const chinLimit = geometry.chinY === null || geometry.chinY === undefined
    ? faceEdges.bottom
    : geometry.chinY - face.height * 0.02;
  const lower = Math.min(
    1,
    faceEdges.bottom,
    chinLimit,
    mouthEdges.bottom + mouth.height * 1.25,
  );
  if (!(lower > mouthEdges.bottom + mouth.height * 0.35)) return null;

  const safeRegion = createBoxFromEdges(left, upper, right, lower);
  if (!safeRegion || !isInsideFace(safeRegion, face) ||
      expandedEyes.some((box) => boxesOverlap(safeRegion, box))) return null;

  const lipBand = createBoxFromEdges(
    Math.max(left, mouthEdges.left - mouth.width * 0.12),
    Math.max(upper, mouthEdges.top - mouth.height * 0.20),
    Math.min(right, mouthEdges.right + mouth.width * 0.12),
    Math.min(lower, mouthEdges.bottom + mouth.height * 0.35),
  );
  if (!lipBand) return null;

  const upperLipAnchorY = mouthEdges.top + mouth.height * 0.20;
  const lowerExpansionLimitY = lower;
  const conservativeLimit = conservative ? mouth.height * 0.80 : Infinity;
  const maximumOpeningHeight = Math.min(
    mouth.width * 0.50,
    mouth.height * 2.00,
    lowerExpansionLimitY - upperLipAnchorY,
    conservativeLimit,
  );
  if (!(maximumOpeningHeight > 0)) return null;

  return {
    faceBox: face,
    mouthBox: mouth,
    leftEyeBox: geometry.leftEyeBox || null,
    rightEyeBox: geometry.rightEyeBox || null,
    noseBox: geometry.noseBox || null,
    chinY: geometry.chinY ?? null,
    safeRegion,
    lipBandBox: lipBand,
    upperLipAnchorY: clamp(upperLipAnchorY),
    lowerExpansionLimitY: clamp(lowerExpansionLimitY),
    maximumOpeningHeight,
    suggestedView: deriveSuggestedView(face),
    protection: conservative ? 'conservative' : 'detected',
  };
}

/**
 * Build the renderer-safe rig from validated feature geometry. The complete
 * patch is deliberately below the protected eye/nose regions.
 */
export function deriveSafeMouthRig(geometry) {
  const validated = validateVisionGeometry(geometry);
  if (!validated) return null;
  const conservative = !validated.leftEyeBox || !validated.rightEyeBox ||
    !validated.noseBox || validated.chinY === null;
  return createSafeRegion(validated, conservative);
}

/**
 * Manual mode still needs only one mouth box. With no facial observations we
 * use deliberately smaller bounds and an opening limit that cannot reach
 * another detail of the provider image.
 */
export function deriveManualSafeRig(mouthBox) {
  const mouth = normalizeVisionBox(mouthBox);
  if (!mouth) return null;
  const edges = getEdges(mouth);
  const safeRegion = createBoxFromEdges(
    clamp(edges.left - mouth.width * 0.25),
    clamp(edges.top - mouth.height * 0.35),
    clamp(edges.right + mouth.width * 0.25),
    clamp(edges.bottom + mouth.height * 0.90),
  );
  if (!safeRegion) return null;
  const lipBandBox = createBoxFromEdges(
    Math.max(safeRegion.x - safeRegion.width / 2, edges.left - mouth.width * 0.12),
    Math.max(safeRegion.y - safeRegion.height / 2, edges.top - mouth.height * 0.20),
    Math.min(safeRegion.x + safeRegion.width / 2, edges.right + mouth.width * 0.12),
    Math.min(safeRegion.y + safeRegion.height / 2, edges.bottom + mouth.height * 0.35),
  );
  const upperLipAnchorY = edges.top + mouth.height * 0.20;
  const maximumOpeningHeight = Math.min(mouth.width * 0.45, mouth.height * 0.80);
  if (!lipBandBox || !(maximumOpeningHeight > 0)) return null;
  return {
    faceBox: null,
    mouthBox: mouth,
    leftEyeBox: null,
    rightEyeBox: null,
    noseBox: null,
    chinY: null,
    safeRegion,
    lipBandBox,
    upperLipAnchorY,
    lowerExpansionLimitY: Math.min(1, edges.top + mouth.height * 1.15),
    maximumOpeningHeight,
    suggestedView: null,
    protection: 'conservative',
  };
}

function resultForFailure(reason) {
  return { ok: false, source: 'gemini-vision', reason };
}

function normalizeMimeType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function isAborted(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

/** Validate one backend preparation envelope and derive both capabilities. */
export function validatePreparedAvatarGeometry(payload, expectedSourceHash = null) {
  if (!payload || typeof payload !== 'object' ||
      payload.version !== AVATAR_PREPARATION_VERSION ||
      payload.analysisVersion !== AVATAR_ANALYSIS_VERSION ||
      typeof payload.sourceHash !== 'string') return null;

  const sourceHash = payload.sourceHash.trim().toLowerCase();
  if (!SHA256.test(sourceHash)) return null;
  if (expectedSourceHash !== null && sourceHash !== expectedSourceHash) return null;

  const rawGeometry = payload.geometry;
  const geometry = validateVisionGeometry(rawGeometry);
  const meshGeometry = validateMeshGeometry(rawGeometry);
  const safeRig = geometry ? deriveSafeMouthRig(geometry) : null;
  if ((!geometry || !safeRig) && !meshGeometry) return null;

  return {
    ok: true,
    source: 'gemini-vision',
    sourceHash,
    cacheHit: payload.cacheHit === true,
    rawGeometry,
    geometry,
    meshGeometry,
    safeRig,
  };
}

/**
 * Send raw image bytes to the backend preparation boundary. The response is a
 * versioned envelope containing one canonical geometry object; body and mouth
 * capabilities are validated independently so one missing feature does not
 * discard the other.
 */
export async function prepareAvatarImage(options = {}) {
  const imageBytes = options.imageBytes;
  const mimeType = normalizeMimeType(options.mimeType);
  if (!ALLOWED_AVATAR_IMAGE_TYPES.has(mimeType)) return resultForFailure('invalid');

  const byteLength = imageBytes?.byteLength ?? imageBytes?.length ?? 0;
  if (!byteLength || byteLength > AVATAR_ANALYSIS_MAX_BYTES) {
    return resultForFailure('invalid');
  }

  const expectedSourceHash = typeof options.expectedSourceHash === 'string'
    ? options.expectedSourceHash.trim().toLowerCase()
    : null;
  if (expectedSourceHash !== null && !SHA256.test(expectedSourceHash)) {
    return resultForFailure('invalid');
  }

  const callerSignal = options.signal || null;
  let controller = null;
  let signal = callerSignal;
  let timeoutId = null;
  if (!callerSignal && typeof AbortController !== 'undefined') {
    controller = new AbortController();
    signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(),
      options.timeoutMs || DEFAULT_ANALYSIS_TIMEOUT_MS);
  }

  try {
    const response = await fetch(getBackendUrl('/api/avatar/prepare'), {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: imageBytes,
      signal,
    });

    if (response.status === 422) return resultForFailure('not-detected');
    if (response.status === 429) return resultForFailure('quota');
    if ([400, 413].includes(response.status)) return resultForFailure('invalid');
    if (!response.ok) return resultForFailure('unavailable');

    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      return resultForFailure('invalid');
    }
    const envelopeIsValid = payload && typeof payload === 'object' &&
      payload.version === AVATAR_PREPARATION_VERSION &&
      payload.analysisVersion === AVATAR_ANALYSIS_VERSION &&
      typeof payload.sourceHash === 'string' &&
      SHA256.test(payload.sourceHash.trim().toLowerCase()) &&
      (expectedSourceHash === null ||
        payload.sourceHash.trim().toLowerCase() === expectedSourceHash);
    if (!envelopeIsValid) return resultForFailure('invalid');
    const prepared = validatePreparedAvatarGeometry(payload, expectedSourceHash);
    return prepared || resultForFailure('not-detected');
  } catch (error) {
    if (isAborted(error, signal)) return resultForFailure('aborted');
    return resultForFailure('unavailable');
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
