/**
 * Shared source-image → viewport geometry.
 *
 * The base image and the transparent mouth overlay must use the same
 * transform. Keeping this math pure prevents the mouth from drifting when the
 * avatar is resized, cropped, repositioned, or zoomed.
 */

function finitePositive(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : 1;
}

function clampUnit(value, fallback = 0.5) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(1, Math.max(0, numericValue));
}

function clampZoom(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(2, Math.max(0.5, numericValue));
}

/**
 * Compute a CSS-like image transform in target/backing-store pixels.
 *
 * `positionX` and `positionY` follow CSS object-position semantics: 0 aligns
 * the source's leading edge, 0.5 centers it, and 1 aligns its trailing edge.
 *
 * @param {{sourceWidth:number, sourceHeight:number, targetWidth:number,
 *   targetHeight:number, fit?:'cover'|'contain', positionX?:number,
 *   positionY?:number, zoom?:number}} options
 * @returns {{sourceWidth:number, sourceHeight:number, targetWidth:number,
 *   targetHeight:number, fit:string, positionX:number, positionY:number,
 *   zoom:number, scale:number, renderWidth:number, renderHeight:number,
 *   offsetX:number, offsetY:number}}
 */
export function computeImageTransform(options = {}) {
  const sourceWidth = finitePositive(options.sourceWidth);
  const sourceHeight = finitePositive(options.sourceHeight);
  const targetWidth = finitePositive(options.targetWidth);
  const targetHeight = finitePositive(options.targetHeight);
  const fit = options.fit === 'contain' ? 'contain' : 'cover';
  const positionX = clampUnit(options.positionX);
  const positionY = clampUnit(options.positionY);
  const zoom = clampZoom(options.zoom);

  const fitScale = fit === 'contain' ? Math.min : Math.max;
  const scale = fitScale(
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  ) * zoom;
  const renderWidth = sourceWidth * scale;
  const renderHeight = sourceHeight * scale;

  return Object.freeze({
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    fit,
    positionX,
    positionY,
    zoom,
    scale,
    renderWidth,
    renderHeight,
    offsetX: (targetWidth - renderWidth) * positionX,
    offsetY: (targetHeight - renderHeight) * positionY,
  });
}

/**
 * Backward-compatible centered cover helper for callers that still use the
 * old name. New code should use computeImageTransform().
 */
export function computeCoverTransform(options = {}) {
  return computeImageTransform({
    ...options,
    fit: 'cover',
    positionX: options.positionX ?? 0.5,
    positionY: options.positionY ?? 0.5,
  });
}

/**
 * Map a normalized source-image mouth box to target/backing-store pixels.
 *
 * @param {{x:number,y:number,width:number,height:number}} box
 * @param {ReturnType<typeof computeCoverTransform>} transform
 */
export function mapSourceBoxToTarget(box, transform) {
  if (!box || !transform) return null;

  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;

  const left = transform.offsetX + (x - width / 2) * transform.renderWidth;
  const top = transform.offsetY + (y - height / 2) * transform.renderHeight;

  return {
    left,
    top,
    width: width * transform.renderWidth,
    height: height * transform.renderHeight,
    centerX: transform.offsetX + x * transform.renderWidth,
    centerY: transform.offsetY + y * transform.renderHeight,
  };
}

/**
 * Return the source texture coordinates visible in the target viewport.
 * This helper remains available for geometry consumers that need a source
 * crop; the normal single-image renderer uses the HTML image and mouth Canvas.
 */
export function computeCoverTextureCoordinates(transform) {
  if (!transform) {
    return { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
  }

  const uMin = Math.max(0, -transform.offsetX / transform.renderWidth);
  const uMax = Math.min(1, (transform.targetWidth - transform.offsetX) / transform.renderWidth);
  const vMin = Math.max(0, -transform.offsetY / transform.renderHeight);
  const vMax = Math.min(1, (transform.targetHeight - transform.offsetY) / transform.renderHeight);

  return {
    uMin,
    uMax,
    vMin,
    vMax,
  };
}
