/**
 * Low-latency audio-driven mouth overlay for a single provider image.
 *
 * The provider image remains an ordinary HTML image underneath this
 * transparent canvas. During speech this renderer draws only a small cached
 * source patch around the mouth; it never redraws the complete avatar image.
 */

import { computeImageTransform, mapSourceBoxToTarget } from './avatar_geometry.js';

export const DEFAULT_MOUTH_COLORS = Object.freeze({
  cover: '#f0c2ae',
  lip: '#c96f73',
  inner: '#4a2d2d',
  tongue: '#e78d94',
  teeth: '#fffaf5',
});

export const MOUTH_STYLE_PRESETS = Object.freeze({
  minimal: Object.freeze({
    maxStretchX: 0.015,
    maxStretchY: 0.18,
    // These are fractions of the configured mouth box, not arbitrary pixels.
    // Keeping the width dominant preserves a horizontal mouth at small audio
    // levels instead of turning the opening into a dot.
    innerWidth: 0.58,
    innerHeight: 0.20,
    openingOpacity: 0.68,
    patchPaddingX: 1.8,
    patchPaddingY: 2,
    feather: 0.22,
    teeth: false,
    tongue: false,
  }),
  soft: Object.freeze({
    maxStretchX: 0.025,
    maxStretchY: 0.28,
    innerWidth: 0.64,
    innerHeight: 0.27,
    openingOpacity: 0.78,
    patchPaddingX: 2,
    patchPaddingY: 2.2,
    feather: 0.2,
    teeth: false,
    tongue: false,
  }),
  cartoon: Object.freeze({
    maxStretchX: 0.04,
    maxStretchY: 0.38,
    innerWidth: 0.70,
    innerHeight: 0.34,
    openingOpacity: 0.86,
    patchPaddingX: 2,
    patchPaddingY: 2.2,
    feather: 0.18,
    teeth: true,
    tongue: true,
  }),
});

const DEFAULT_STYLE = 'cartoon';
const OPENING_GATE = 0.04;
const ATTACK_EASING = 0.68;
const RELEASE_EASING = 0.24;

function clamp(value, minimum = 0, maximum = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return minimum;
  return Math.min(maximum, Math.max(minimum, numericValue));
}

function hexToRgb(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b]
    .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixColors(first, second, amount) {
  const left = hexToRgb(first) || hexToRgb(DEFAULT_MOUTH_COLORS.cover);
  const right = hexToRgb(second) || left;
  const ratio = clamp(amount);
  return rgbToHex({
    r: left.r + (right.r - left.r) * ratio,
    g: left.g + (right.g - left.g) * ratio,
    b: left.b + (right.b - left.b) * ratio,
  });
}

function darken(color, amount) {
  const rgb = hexToRgb(color) || hexToRgb(DEFAULT_MOUTH_COLORS.cover);
  const multiplier = 1 - clamp(amount);
  return rgbToHex({ r: rgb.r * multiplier, g: rgb.g * multiplier, b: rgb.b * multiplier });
}

function lighten(color, amount) {
  return mixColors(color, '#ffffff', amount);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function easeMouthLevel(currentLevel, targetLevel) {
  const current = clamp(currentLevel);
  const target = clamp(targetLevel);
  const coefficient = target > current ? ATTACK_EASING : RELEASE_EASING;
  return current + (target - current) * coefficient;
}

export function getMouthStylePreset(style = DEFAULT_STYLE) {
  const name = String(style || DEFAULT_STYLE).toLowerCase();
  return {
    name: MOUTH_STYLE_PRESETS[name] ? name : DEFAULT_STYLE,
    ...MOUTH_STYLE_PRESETS[name] || MOUTH_STYLE_PRESETS[DEFAULT_STYLE],
  };
}

/**
 * Convert one already-smoothed display level into drawing parameters.
 * Temporal easing deliberately does not happen here; the renderer owns one
 * attack/release envelope in its animation loop.
 */
export function computeMouthShape(level, options = {}) {
  const normalized = clamp(level);
  const preset = getMouthStylePreset(options.style);
  const opening = normalized <= OPENING_GATE
    ? 0
    : clamp((normalized - OPENING_GATE) / (1 - OPENING_GATE));

  return {
    level: normalized,
    openness: opening,
    widthFactor: 1 + opening * preset.maxStretchX,
    heightFactor: 0.08 + opening * 0.92,
    // The source safe patch is always drawn at its original scale. Only the
    // small lip band may use this bounded deformation amount.
    lipBandScaleX: 1 + opening * preset.maxStretchX,
    lipBandScaleY: 1 + opening * preset.maxStretchY,
    openingOpacity: clamp(opening * preset.openingOpacity),
    showTeeth: preset.teeth && opening > 0.42,
    showTongue: preset.tongue && opening > 0.64,
    visible: opening > 0,
  };
}

/**
 * Calculate a horizontal mouth opening in target pixels.
 *
 * A single neutral image cannot reveal hidden open-mouth pixels. The renderer
 * therefore paints a small, source-aligned aperture over the cached source
 * patch. The old implementation sized an ellipse from the box height; on a
 * narrow mouth that made the opening look like a dark circle. This geometry
 * keeps width tied to the mouth box and limits vertical growth separately.
 */
export function computeMouthOpeningGeometry(
  box,
  shape,
  preset = getMouthStylePreset(),
  maximumOpeningHeight = Infinity,
  upperLipAnchorY = null,
  lowerExpansionLimitY = Infinity,
) {
  if (!box || typeof box !== 'object' || !shape || !preset) return null;

  const centerX = Number(box.centerX);
  const boxTop = Number(box.top);
  const boxWidth = Number(box.width);
  const boxHeight = Number(box.height);
  if (![centerX, boxTop, boxWidth, boxHeight].every(Number.isFinite) ||
      !(boxWidth > 0 && boxHeight > 0)) return null;

  const openness = clamp(shape.openness);
  if (!(openness > 0)) return null;

  const widthFraction = clamp(
    Number(preset.innerWidth) + openness * 0.10,
    0.45,
    0.92,
  );
  const width = Math.min(boxWidth * 0.92, boxWidth * widthFraction);
  const requestedHeight = boxHeight * (
    0.08 + openness * Number(preset.innerHeight || 0.24)
  );
  const safeMaximumHeight = Number(maximumOpeningHeight);
  const heightLimit = Number.isFinite(safeMaximumHeight) && safeMaximumHeight > 0
    ? safeMaximumHeight
    : Infinity;

  const lowerLimit = Number.isFinite(Number(lowerExpansionLimitY))
    ? Number(lowerExpansionLimitY)
    : boxTop + boxHeight;
  const anchor = Number.isFinite(Number(upperLipAnchorY))
    ? Number(upperLipAnchorY)
    : boxTop + boxHeight * 0.24;
  const top = Math.min(
    Math.max(boxTop, anchor),
    boxTop + boxHeight,
  );
  const availableHeight = Math.max(1, lowerLimit - top);
  const height = Math.min(
    Math.max(1.25, requestedHeight),
    Math.max(1.25, heightLimit),
    availableHeight,
    Math.max(1.25, boxTop + boxHeight - top),
  );
  const centerY = top + height / 2;

  return {
    centerX,
    centerY,
    width,
    height,
    left: centerX - width / 2,
    top,
    right: centerX + width / 2,
    bottom: top + height,
    openness,
  };
}

/**
 * Return a padded, clamped source-image box used as the cached mouth patch.
 */
export function computeAdaptiveTexturePatch(
  mouthBox,
  sourceWidth = 1,
  sourceHeight = 1,
  options = {},
) {
  if (!mouthBox || typeof mouthBox !== 'object') return null;

  const x = Number(mouthBox.x);
  const y = Number(mouthBox.y);
  const width = Number(mouthBox.width);
  const height = Number(mouthBox.height);
  const imageWidth = Number(sourceWidth);
  const imageHeight = Number(sourceHeight);
  if (![x, y, width, height, imageWidth, imageHeight].every(Number.isFinite) ||
      width <= 0 || height <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const paddingX = Number.isFinite(Number(options.paddingX))
    ? Math.max(1, Number(options.paddingX))
    : 2;
  const paddingY = Number.isFinite(Number(options.paddingY))
    ? Math.max(1, Number(options.paddingY))
    : 2.2;
  const requestedWidth = Math.min(1, width * paddingX);
  const requestedHeight = Math.min(1, height * paddingY);
  const left = Math.max(0, Math.min(1, x - requestedWidth / 2));
  const top = Math.max(0, Math.min(1, y - requestedHeight / 2));
  const right = Math.max(left, Math.min(1, x + requestedWidth / 2));
  const bottom = Math.max(top, Math.min(1, y + requestedHeight / 2));
  const actualWidth = right - left;
  const actualHeight = bottom - top;

  if (actualWidth <= 0 || actualHeight <= 0) return null;

  return {
    sourceBox: {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: actualWidth,
      height: actualHeight,
    },
    sourceRect: {
      x: left * imageWidth,
      y: top * imageHeight,
      width: actualWidth * imageWidth,
      height: actualHeight * imageHeight,
    },
  };
}

/** Derive a flat-cartoon palette from pixels surrounding the mouth. */
export function deriveMouthColors(imageData, mouthBox, overrides = {}) {
  const fallback = { ...DEFAULT_MOUTH_COLORS };
  if (!imageData?.data || !mouthBox) return { ...fallback, ...overrides };

  const { data, width, height } = imageData;
  const left = Math.max(0, Math.floor((mouthBox.x - mouthBox.width * 0.75) * width));
  const right = Math.min(width - 1, Math.ceil((mouthBox.x + mouthBox.width * 0.75) * width));
  const top = Math.max(0, Math.floor((mouthBox.y - mouthBox.height * 0.8) * height));
  const bottom = Math.min(height - 1, Math.ceil((mouthBox.y + mouthBox.height * 0.8) * height));
  const innerLeft = (mouthBox.x - mouthBox.width * 0.28) * width;
  const innerRight = (mouthBox.x + mouthBox.width * 0.28) * width;
  const innerTop = (mouthBox.y - mouthBox.height * 0.28) * height;
  const innerBottom = (mouthBox.y + mouthBox.height * 0.28) * height;

  const channels = { r: [], g: [], b: [] };
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (x >= innerLeft && x <= innerRight && y >= innerTop && y <= innerBottom) continue;
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 128) continue;
      channels.r.push(data[offset]);
      channels.g.push(data[offset + 1]);
      channels.b.push(data[offset + 2]);
    }
  }

  const sampled = channels.r.length
    ? rgbToHex({ r: median(channels.r), g: median(channels.g), b: median(channels.b) })
    : fallback.cover;

  return {
    cover: sampled,
    lip: mixColors(sampled, '#c45f68', 0.42),
    inner: darken(sampled, 0.68),
    tongue: lighten(mixColors(sampled, '#d86578', 0.55), 0.14),
    teeth: fallback.teeth,
    ...overrides,
  };
}

/** Build the internal rig from the provider's one mouth rectangle. */
export function createAvatarRig(options = {}) {
  const mouthBox = options.mouthBox;
  if (!mouthBox) return null;

  const style = getMouthStylePreset(options.style);
  const sourceWidth = Number(options.sourceWidth) || 1;
  const sourceHeight = Number(options.sourceHeight) || 1;
  const fallbackPatch = computeAdaptiveTexturePatch(mouthBox, sourceWidth, sourceHeight, {
      paddingX: style.patchPaddingX,
      paddingY: style.patchPaddingY,
    });
  const safeRegion = options.safeRegion || options.patchBox || fallbackPatch?.sourceBox || null;
  const lipBandBox = options.lipBandBox || mouthBox;
  const patch = safeRegion
    ? {
      sourceBox: safeRegion,
      sourceRect: options.patchRect || {
        x: (safeRegion.x - safeRegion.width / 2) * sourceWidth,
        y: (safeRegion.y - safeRegion.height / 2) * sourceHeight,
        width: safeRegion.width * sourceWidth,
        height: safeRegion.height * sourceHeight,
      },
    }
    : null;
  const maximumOpeningHeight = Number(options.maximumOpeningHeight) > 0
    ? Number(options.maximumOpeningHeight)
    : Math.min(mouthBox.height * 0.8, mouthBox.width * 0.45);

  return {
    rigVersion: Number(options.rigVersion) || 4,
    analysisVersion: Number(options.analysisVersion) || 2,
    analyzerModel: options.analyzerModel || null,
    confidence: Number.isFinite(Number(options.confidence))
      ? Number(options.confidence)
      : null,
    faceBox: options.faceBox || null,
    mouthBox: { ...mouthBox },
    leftEyeBox: options.leftEyeBox || null,
    rightEyeBox: options.rightEyeBox || null,
    noseBox: options.noseBox || null,
    chinY: options.chinY ?? null,
    safeRegion,
    lipBandBox,
    upperLipAnchorY: Number.isFinite(Number(options.upperLipAnchorY))
      ? Number(options.upperLipAnchorY)
      : Math.max(0, mouthBox.y - mouthBox.height * 0.3),
    lowerExpansionLimitY: Number.isFinite(Number(options.lowerExpansionLimitY))
      ? Number(options.lowerExpansionLimitY)
      : Math.min(1, mouthBox.y + mouthBox.height * 1.15),
    closedWidth: Number(options.closedWidth) > 0
      ? Number(options.closedWidth)
      : mouthBox.width,
    closedHeight: Number(options.closedHeight) > 0
      ? Number(options.closedHeight)
      : Math.min(mouthBox.height * 0.42, mouthBox.width * 0.18),
    maximumOpeningHeight,
    patchBox: patch?.sourceBox || null,
    patchRect: patch?.sourceRect || null,
    source: options.source || 'manual',
    colors: { ...DEFAULT_MOUTH_COLORS, ...(options.colors || {}) },
    style: style.name,
    protection: options.protection === 'detected' ? 'detected' : 'conservative',
    suggestedView: options.suggestedView || null,
  };
}

function roundedEllipse(context, centerX, centerY, radiusX, radiusY) {
  context.beginPath();
  context.ellipse(
    centerX,
    centerY,
    Math.max(1, radiusX),
    Math.max(1, radiusY),
    0,
    0,
    Math.PI * 2,
  );
}

/** Draw an almond/lip aperture instead of a circular ellipse. */
function beginMouthOpeningPath(context, geometry) {
  if (!context || !geometry ||
      typeof context.beginPath !== 'function' ||
      typeof context.moveTo !== 'function' ||
      typeof context.bezierCurveTo !== 'function' ||
      typeof context.closePath !== 'function') return false;

  const halfWidth = Math.max(1, Number(geometry.width) / 2);
  const halfHeight = Math.max(0.75, Number(geometry.height) / 2);
  const centerX = Number(geometry.centerX);
  const centerY = Number(geometry.centerY);
  if (![centerX, centerY, halfWidth, halfHeight].every(Number.isFinite)) return false;

  const left = centerX - halfWidth;
  const right = centerX + halfWidth;
  const top = centerY - halfHeight;
  const bottom = centerY + halfHeight;
  const controlX = Math.max(1, halfWidth * 0.30);

  context.beginPath();
  context.moveTo(left, centerY);
  // The upper contour peaks in the middle, like a simple smiling lip line.
  context.bezierCurveTo(
    left + controlX,
    top,
    centerX - controlX * 0.56,
    top,
    centerX,
    top,
  );
  context.bezierCurveTo(
    centerX + controlX * 0.56,
    top,
    right - controlX,
    top,
    right,
    centerY,
  );
  // The lower contour is slightly fuller but remains bounded by the mouth box.
  context.bezierCurveTo(
    right - controlX,
    bottom,
    centerX + controlX * 0.56,
    bottom,
    centerX,
    bottom,
  );
  context.bezierCurveTo(
    centerX - controlX * 0.56,
    bottom,
    left + controlX,
    bottom,
    left,
    centerY,
  );
  context.closePath();
  return true;
}

function fillMouthOpening(context, geometry) {
  if (beginMouthOpeningPath(context, geometry)) {
    context.fill();
    return true;
  }

  // Older/minimal Canvas implementations may not expose cubic path methods.
  // Keep voice support functional there, but use this only as a compatibility
  // fallback; modern Chrome and Edge use the lip-shaped path above.
  if (typeof context?.ellipse !== 'function') return false;
  roundedEllipse(
    context,
    geometry.centerX,
    geometry.centerY,
    geometry.width / 2,
    geometry.height / 2,
  );
  context.fill();
  return true;
}

function scaleMouthOpeningGeometry(geometry, scaleX = 1, scaleY = 1) {
  if (!geometry) return null;
  const width = Math.max(1.25, geometry.width * Math.max(0.5, Number(scaleX) || 1));
  const height = Math.max(1.25, geometry.height * Math.max(0.5, Number(scaleY) || 1));
  return {
    ...geometry,
    width,
    height,
    left: geometry.centerX - width / 2,
    top: geometry.centerY - height / 2,
    right: geometry.centerX + width / 2,
    bottom: geometry.centerY + height / 2,
  };
}

function getImageDimensions(image) {
  const width = Number(image?.naturalWidth || image?.width);
  const height = Number(image?.naturalHeight || image?.height);
  if (!(width > 0 && height > 0)) return null;
  return { width, height };
}

/**
 * Convert a source-normalized mesh head transform into target pixels.
 *
 * Exported so the alignment contract can be tested without a DOM or Canvas
 * implementation. The renderer uses the same transform internally.
 */
export function getTargetHeadTransform(headTransform, imageTransform) {
  if (!headTransform || !imageTransform) return null;
  return {
    pivotX: imageTransform.offsetX + headTransform.pivotX * imageTransform.renderWidth,
    pivotY: imageTransform.offsetY + headTransform.pivotY * imageTransform.renderHeight,
    translateX: headTransform.translateX * imageTransform.renderWidth,
    translateY: headTransform.translateY * imageTransform.renderHeight,
    rotation: Number(headTransform.rotationRadians) || 0,
    scaleX: Number.isFinite(Number(headTransform.scaleX)) ? Number(headTransform.scaleX) : 1,
    scaleY: Number.isFinite(Number(headTransform.scaleY)) ? Number(headTransform.scaleY) : 1,
  };
}

/** Apply one target-pixel affine transform around its mapped pivot. */
export function transformTargetPoint(x, y, transform) {
  if (!transform) return { x, y };
  const scaledX = (x - transform.pivotX) * transform.scaleX;
  const scaledY = (y - transform.pivotY) * transform.scaleY;
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return {
    x: transform.pivotX + scaledX * cosine - scaledY * sine + transform.translateX,
    y: transform.pivotY + scaledX * sine + scaledY * cosine + transform.translateY,
  };
}

function transformedRect(rect, transform) {
  if (!rect || !transform) return rect;
  const points = [
    transformTargetPoint(rect.left, rect.top, transform),
    transformTargetPoint(rect.left + rect.width, rect.top, transform),
    transformTargetPoint(rect.left, rect.top + rect.height, transform),
    transformTargetPoint(rect.left + rect.width, rect.top + rect.height, transform),
  ];
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, width: right - left, height: bottom - top };
}

function applyTargetTransform(context, transform) {
  if (!context || !transform) return;
  context.translate(
    transform.pivotX + transform.translateX,
    transform.pivotY + transform.translateY,
  );
  context.rotate(transform.rotation);
  context.scale(transform.scaleX, transform.scaleY);
  context.translate(-transform.pivotX, -transform.pivotY);
}

function createCanvas(width, height) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
  }
  return null;
}

function clearCanvas(canvas, context) {
  if (!canvas || !context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawAdaptiveOpening(
  context,
  box,
  shape,
  colors,
  preset,
  maximumOpeningHeight = Infinity,
  upperLipAnchorY = box.centerY,
  lowerExpansionLimitY = Infinity,
) {
  const geometry = computeMouthOpeningGeometry(
    box,
    shape,
    preset,
    maximumOpeningHeight,
    upperLipAnchorY,
    lowerExpansionLimitY,
  );
  if (!geometry) return;

  // Keep the original source patch as the visual base and add only a restrained
  // lip contour plus the opening. The previous implementation painted one
  // dark ellipse, which erased the character of a narrow neutral mouth.
  const lipGeometry = scaleMouthOpeningGeometry(
    geometry,
    1 + Math.max(0, shape.lipBandScaleX - 1) * 0.65,
    1 + Math.max(0, shape.lipBandScaleY - 1) * 0.22,
  );

  context.save();
  context.globalAlpha = Math.min(0.48, 0.10 + shape.openingOpacity * 0.38);
  context.fillStyle = colors.lip;
  fillMouthOpening(context, lipGeometry);

  context.globalAlpha = Math.min(0.9, 0.18 + shape.openingOpacity * 0.72);
  context.fillStyle = colors.inner;
  fillMouthOpening(context, geometry);
  context.restore();
}

function drawProceduralFallback(context, box, shape, colors, preset, maximumOpeningHeight = Infinity,
  upperLipAnchorY = box.centerY, lowerExpansionLimitY = Infinity) {
  const geometry = computeMouthOpeningGeometry(
    box,
    shape,
    preset,
    maximumOpeningHeight,
    upperLipAnchorY,
    lowerExpansionLimitY,
  );
  if (!geometry) return;

  const coverGeometry = scaleMouthOpeningGeometry(
    geometry,
    1.18,
    Math.min(1.35, 1.05 + shape.openness * 0.22),
  );
  const lipGeometry = scaleMouthOpeningGeometry(geometry, 1.08, 1.18);

  context.save();
  context.globalAlpha = 0.98;
  context.fillStyle = colors.cover;
  fillMouthOpening(context, coverGeometry);

  context.fillStyle = colors.lip;
  fillMouthOpening(context, lipGeometry);

  context.fillStyle = colors.inner;
  fillMouthOpening(context, geometry);

  if (shape.showTeeth && preset.teeth) {
    context.save();
    const clipped = beginMouthOpeningPath(context, geometry);
    if (!clipped && typeof context.ellipse === 'function') {
      roundedEllipse(context, geometry.centerX, geometry.centerY,
        geometry.width / 2, geometry.height / 2);
    }
    if (typeof context.clip === 'function') context.clip();
    context.globalAlpha = Math.min(0.94, (shape.openness - 0.42) * 1.7);
    context.fillStyle = colors.teeth;
    context.fillRect(
      geometry.left,
      geometry.top,
      geometry.width,
      geometry.height * 0.42,
    );
    context.restore();
  }

  if (shape.showTongue && preset.tongue) {
    context.globalAlpha = Math.min(0.92, (shape.openness - 0.64) * 2.2);
    context.fillStyle = colors.tongue;
    const tongue = scaleMouthOpeningGeometry(geometry, 0.58, 0.42);
    tongue.centerY += geometry.height * 0.22;
    fillMouthOpening(context, tongue);
  }
  context.restore();
}

export class AdaptiveTextureMouthRenderer {
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.context = this.canvas?.getContext?.('2d', { alpha: true }) || null;
    this.image = options.image || null;
    this.mouthBox = null;
    this.rig = null;
    this.colors = { ...DEFAULT_MOUTH_COLORS };
    this.transformProvider = options.transformProvider || null;
    this.deformationProvider = options.deformationProvider || null;
    this.zoom = Number.isFinite(Number(options.zoom)) ? Number(options.zoom) : 1;
    this.speaking = false;
    this.level = 0;
    this.targetLevel = 0;
    this.animationFrame = null;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.sourcePatchCanvas = null;
    this.sourcePatchContext = null;
    this.frameCanvas = null;
    this.frameContext = null;
    this.maskCanvas = null;
    this.maskContext = null;
    this.maskKey = null;
    this.lastDrawRect = null;
  }

  get available() {
    return Boolean(this.canvas && this.context);
  }

  configure(options = {}) {
    this.image = options.image || this.image;
    this.mouthBox = options.mouthBox || null;
    this.colors = { ...DEFAULT_MOUTH_COLORS, ...(options.colors || {}) };
    this.transformProvider = options.transformProvider || this.transformProvider;
    this.deformationProvider = options.deformationProvider || this.deformationProvider;
    if (Number.isFinite(Number(options.zoom))) this.zoom = Number(options.zoom);

    const dimensions = getImageDimensions(this.image) || { width: 1, height: 1 };
    this.rig = options.rig || createAvatarRig({
      mouthBox: this.mouthBox,
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      colors: this.colors,
      style: options.style,
      source: options.source,
    });
    this.mouthBox = this.rig?.mouthBox || this.mouthBox;
    this.colors = { ...this.colors, ...(this.rig?.colors || {}) };
    this.prepareSourcePatch(dimensions);
    this.resize(true);
    this.render();
  }

  prepareSourcePatch(dimensions) {
    this.sourcePatchCanvas = null;
    this.sourcePatchContext = null;
    const patch = this.rig?.patchRect && this.rig?.patchBox
      ? { sourceRect: this.rig.patchRect, sourceBox: this.rig.patchBox }
      : computeAdaptiveTexturePatch(
        this.mouthBox,
        dimensions.width,
        dimensions.height,
        { paddingX: getMouthStylePreset(this.rig?.style).patchPaddingX,
          paddingY: getMouthStylePreset(this.rig?.style).patchPaddingY },
      );
    if (!patch || !this.image) return;

    const patchCanvas = createCanvas(patch.sourceRect.width, patch.sourceRect.height);
    const patchContext = patchCanvas?.getContext?.('2d', { alpha: true });
    if (!patchCanvas || !patchContext || typeof patchContext.drawImage !== 'function') return;

    try {
      patchContext.drawImage(
        this.image,
        patch.sourceRect.x,
        patch.sourceRect.y,
        patch.sourceRect.width,
        patch.sourceRect.height,
        0,
        0,
        patchCanvas.width,
        patchCanvas.height,
      );
      this.sourcePatchCanvas = patchCanvas;
      this.sourcePatchContext = patchContext;
    } catch (_) {
      this.sourcePatchCanvas = null;
      this.sourcePatchContext = null;
    }
  }

  resize(force = false) {
    if (!this.canvas || !this.context) return;
    const rect = this.canvas.getBoundingClientRect?.();
    const cssWidth = rect?.width || this.canvas.clientWidth || this.canvas.width || 1;
    const cssHeight = rect?.height || this.canvas.clientHeight || this.canvas.height || 1;
    const pixelRatio = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const width = Math.max(1, Math.round(cssWidth * pixelRatio));
    const height = Math.max(1, Math.round(cssHeight * pixelRatio));
    if (!force && this.canvas.width === width && this.canvas.height === height) return;

    this.canvas.width = width;
    this.canvas.height = height;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.lastDrawRect = null;
    clearCanvas(this.canvas, this.context);
    this.frameCanvas = null;
    this.frameContext = null;
    this.maskCanvas = null;
    this.maskContext = null;
    this.maskKey = null;
  }

  getTransform() {
    if (typeof this.transformProvider === 'function') return this.transformProvider();
    const dimensions = getImageDimensions(this.image) || { width: 1, height: 1 };
    return computeImageTransform({
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      targetWidth: this.canvasWidth || 1,
      targetHeight: this.canvasHeight || 1,
      zoom: this.zoom,
    });
  }

  startSpeaking() {
    this.speaking = true;
    this.startLoop();
  }

  setAudioLevel(level) {
    this.targetLevel = clamp(level);
    if (this.speaking) this.startLoop();
  }

  startLoop() {
    if (this.animationFrame !== null || !this.canvas || !this.context ||
      typeof requestAnimationFrame !== 'function') return;

    const tick = () => {
      this.animationFrame = null;
      this.level = easeMouthLevel(this.level, this.targetLevel);
      if (Math.abs(this.targetLevel - this.level) < 0.004) this.level = this.targetLevel;
      this.render();
      if (this.speaking || Math.abs(this.targetLevel - this.level) >= 0.004) {
        this.animationFrame = requestAnimationFrame(tick);
      }
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  clearPreviousPatch() {
    if (!this.lastDrawRect || !this.context) return;
    const margin = 4;
    this.context.clearRect(
      this.lastDrawRect.left - margin,
      this.lastDrawRect.top - margin,
      this.lastDrawRect.width + margin * 2,
      this.lastDrawRect.height + margin * 2,
    );
    this.lastDrawRect = null;
  }

  ensureFrameCanvas(width, height) {
    const safeWidth = Math.max(1, Math.ceil(width));
    const safeHeight = Math.max(1, Math.ceil(height));
    if (this.frameCanvas && this.frameCanvas.width === safeWidth &&
        this.frameCanvas.height === safeHeight) return;
    this.frameCanvas = createCanvas(safeWidth, safeHeight);
    this.frameContext = this.frameCanvas?.getContext?.('2d', { alpha: true }) || null;
  }

  ensureMaskCanvas(width, height, feather) {
    const safeWidth = Math.max(1, Math.ceil(width));
    const safeHeight = Math.max(1, Math.ceil(height));
    const source = typeof feather === 'object' && feather
      ? feather
      : { featherLeft: feather, featherRight: feather, featherTop: feather, featherBottom: feather };
    const normalized = {
      featherLeft: clamp(source.featherLeft, 0, 1),
      featherRight: clamp(source.featherRight, 0, 1),
      featherTop: clamp(source.featherTop, 0, 1),
      featherBottom: clamp(source.featherBottom, 0, 1),
    };
    const key = `${safeWidth}:${safeHeight}:${Object.values(normalized).join(':')}`;
    if (this.maskCanvas && this.maskContext &&
        this.maskCanvas.width === safeWidth && this.maskCanvas.height === safeHeight &&
        this.maskKey === key) {
      return this.maskCanvas;
    }

    const maskCanvas = createCanvas(safeWidth, safeHeight);
    const maskContext = maskCanvas?.getContext?.('2d', { alpha: true });
    if (!maskCanvas || !maskContext) {
      this.maskCanvas = null;
      this.maskContext = null;
      this.maskKey = null;
      return null;
    }

    clearCanvas(maskCanvas, maskContext);
    // A simple opaque fallback is preferable to rebuilding a radial mask on
    // every frame when a minimal Canvas implementation lacks gradients.
    if (typeof maskContext.createLinearGradient !== 'function') {
      maskContext.fillStyle = 'rgba(0, 0, 0, 1)';
      maskContext.fillRect(0, 0, safeWidth, safeHeight);
    } else {
      const leftFade = Math.max(1, safeWidth * normalized.featherLeft);
      const rightFade = Math.max(1, safeWidth * normalized.featherRight);
      const topFade = Math.max(1, safeHeight * normalized.featherTop);
      const bottomFade = Math.max(1, safeHeight * normalized.featherBottom);

      const horizontal = maskContext.createLinearGradient(0, 0, safeWidth, 0);
      horizontal.addColorStop(0, 'rgba(0, 0, 0, 0)');
      horizontal.addColorStop(Math.min(0.49, leftFade / safeWidth), 'rgba(0, 0, 0, 1)');
      horizontal.addColorStop(Math.max(0.51, 1 - rightFade / safeWidth), 'rgba(0, 0, 0, 1)');
      horizontal.addColorStop(1, 'rgba(0, 0, 0, 0)');
      maskContext.fillStyle = horizontal;
      maskContext.fillRect(0, 0, safeWidth, safeHeight);

      const vertical = maskContext.createLinearGradient(0, 0, 0, safeHeight);
      vertical.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vertical.addColorStop(Math.min(0.49, topFade / safeHeight), 'rgba(0, 0, 0, 1)');
      vertical.addColorStop(Math.max(0.51, 1 - bottomFade / safeHeight), 'rgba(0, 0, 0, 1)');
      vertical.addColorStop(1, 'rgba(0, 0, 0, 0)');
      maskContext.globalCompositeOperation = 'destination-in';
      maskContext.fillStyle = vertical;
      maskContext.fillRect(0, 0, safeWidth, safeHeight);
      maskContext.globalCompositeOperation = 'source-over';
    }

    this.maskCanvas = maskCanvas;
    this.maskContext = maskContext;
    this.maskKey = key;
    return maskCanvas;
  }

  applySoftMask(feather) {
    if (!this.frameContext || !this.frameCanvas) return;
    const maskCanvas = this.ensureMaskCanvas(
      this.frameCanvas.width,
      this.frameCanvas.height,
      feather,
    );
    if (!maskCanvas) return;

    this.frameContext.save();
    this.frameContext.globalCompositeOperation = 'destination-in';
    this.frameContext.drawImage(maskCanvas, 0, 0);
    this.frameContext.restore();
  }

  renderCachedPatch(
    targetPatch,
    targetMouth,
    shape,
    preset,
    maximumOpeningHeight,
    upperLipAnchorY,
    lowerExpansionLimitY,
    headTransform = null,
  ) {
    if (!this.sourcePatchCanvas || !this.context) return false;

    // The complete safe patch is copied at its original mapped dimensions.
    // This is the important boundary: eyes, nose, and other artwork can never
    // be stretched as a side effect of mouth opening.
    const frameWidth = targetPatch.width + 8;
    const frameHeight = targetPatch.height + 8;
    this.ensureFrameCanvas(frameWidth, frameHeight);
    if (!this.frameCanvas || !this.frameContext) return false;

    const frame = this.frameContext;
    clearCanvas(this.frameCanvas, frame);
    const originX = 4;
    const originY = 4;
    frame.drawImage(
      this.sourcePatchCanvas,
      originX,
      originY,
      targetPatch.width,
      targetPatch.height,
    );

    const mouthBox = {
      centerX: originX + targetMouth.centerX - targetPatch.left,
      centerY: originY + targetMouth.centerY - targetPatch.top,
      left: originX + targetMouth.left - targetPatch.left,
      top: originY + targetMouth.top - targetPatch.top,
      width: targetMouth.width,
      height: targetMouth.height,
    };
    drawAdaptiveOpening(
      frame,
      mouthBox,
      shape,
      this.colors,
      preset,
      maximumOpeningHeight,
      originY + upperLipAnchorY - targetPatch.top,
      originY + lowerExpansionLimitY - targetPatch.top,
    );
    this.applySoftMask({
      featherLeft: preset.feather * 0.9,
      featherRight: preset.feather * 0.9,
      // The upper feather is intentionally shorter; the lower edge gets more
      // room for the downward opening without exposing a hard patch edge.
      featherTop: preset.feather * 0.45,
      featherBottom: preset.feather * 1.2,
    });

    const left = targetPatch.centerX - this.frameCanvas.width / 2;
    const top = targetPatch.centerY - this.frameCanvas.height / 2;
    const drawRect = { left, top, width: this.frameCanvas.width, height: this.frameCanvas.height };
    this.context.save();
    applyTargetTransform(this.context, headTransform);
    this.context.drawImage(this.frameCanvas, left, top);
    this.context.restore();
    this.lastDrawRect = transformedRect(drawRect, headTransform);
    return true;
  }

  render() {
    if (!this.canvas || !this.context) return;
    this.resize();
    this.clearPreviousPatch();
    if (!this.speaking || !this.mouthBox || !this.rig) return;

    const shape = computeMouthShape(this.level, { style: this.rig.style });
    if (!shape.visible) return;

    const dimensions = getImageDimensions(this.image) || { width: 1, height: 1 };
    const transform = this.getTransform() || computeImageTransform({
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      targetWidth: this.canvas.width,
      targetHeight: this.canvas.height,
      zoom: this.zoom,
    });
    const box = mapSourceBoxToTarget(this.mouthBox, transform);
    const patch = mapSourceBoxToTarget(this.rig.safeRegion || this.rig.patchBox, transform);
    if (!box || !patch) return;
    const headTransform = getTargetHeadTransform(
      this.deformationProvider?.(),
      transform,
    );

    const preset = getMouthStylePreset(this.rig.style);
    if (this.renderCachedPatch(
      patch,
      box,
      shape,
      preset,
      this.rig?.maximumOpeningHeight * transform.renderHeight,
      transform.offsetY + this.rig.upperLipAnchorY * transform.renderHeight,
      transform.offsetY + this.rig.lowerExpansionLimitY * transform.renderHeight,
      headTransform,
    )) return;

    // A browser without an offscreen canvas still receives a local procedural
    // mouth. This fallback never copies the complete provider image.
    this.context.save();
    applyTargetTransform(this.context, headTransform);
    drawProceduralFallback(
      this.context, box, shape, this.colors, preset,
      this.rig?.maximumOpeningHeight * transform.renderHeight,
      transform.offsetY + this.rig.upperLipAnchorY * transform.renderHeight,
      transform.offsetY + this.rig.lowerExpansionLimitY * transform.renderHeight,
    );
    this.context.restore();
    this.lastDrawRect = transformedRect({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    }, headTransform);
  }

  stop() {
    this.speaking = false;
    this.targetLevel = 0;
    this.level = 0;
    if (this.animationFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    clearCanvas(this.canvas, this.context);
    this.lastDrawRect = null;
  }

  destroy() {
    this.stop();
    this.canvas = null;
    this.context = null;
    this.image = null;
    this.mouthBox = null;
    this.rig = null;
    this.sourcePatchCanvas = null;
    this.sourcePatchContext = null;
    this.frameCanvas = null;
    this.frameContext = null;
    this.maskCanvas = null;
    this.maskContext = null;
    this.maskKey = null;
  }
}

export function createAdaptiveTextureMouthRenderer(options = {}) {
  return new AdaptiveTextureMouthRenderer(options);
}
