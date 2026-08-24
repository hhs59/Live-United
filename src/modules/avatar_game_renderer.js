import {
  DEFAULT_LAYERED_AVATAR_MANIFEST_URL,
  loadLayeredAvatarPackage,
} from './avatar_asset_manifest.js?v=7';
import {
  AVATAR_RUNTIME_STATES,
  createAnimatorState,
  createLayerTransforms,
  updateAnimator,
  getGestureDurationMs,
} from './avatar_animator.js?v=12';

const MAX_DEVICE_PIXEL_RATIO = 2;
const VALID_GESTURES = new Set(['neutral', 'wave', 'celebrate', 'emphasize']);

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiply(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function translate(x, y) {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

function rotate(radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

function scale(x, y) {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 };
}

function composeLocalTransform(layer, transform, sourceWidth, sourceHeight) {
  const pivotX = layer.pivot.x * sourceWidth;
  const pivotY = layer.pivot.y * sourceHeight;
  const offsetX = (transform.translateX || 0) * sourceWidth;
  const offsetY = (transform.translateY || 0) * sourceHeight;

  return multiply(
    multiply(
      multiply(
        multiply(translate(pivotX, pivotY), translate(offsetX, offsetY)),
        rotate(transform.rotation || 0),
      ),
      scale(transform.scaleX ?? 1, transform.scaleY ?? 1),
    ),
    translate(-pivotX, -pivotY),
  );
}

function applyMatrix(context, matrix) {
  context.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
}

function resolveWorldMatrices(layers, localTransforms, sourceWidth, sourceHeight) {
  const layersById = new Map(layers.map((layer) => [layer.id, layer]));
  const worldById = new Map();

  function resolve(layer) {
    if (worldById.has(layer.id)) return worldById.get(layer.id);
    const parentWorld = layer.parent === 'root'
      ? identityMatrix()
      : resolve(layersById.get(layer.parent));
    const local = composeLocalTransform(
      layer,
      localTransforms[layer.id] || {},
      sourceWidth,
      sourceHeight,
    );
    const world = multiply(parentWorld, local);
    worldById.set(layer.id, world);
    return world;
  }

  for (const layer of layers) resolve(layer);
  return worldById;
}

function computeFitMatrix(sourceWidth, sourceHeight, targetWidth, targetHeight, fit) {
  const scaleMode = fit === 'cover' ? Math.max : Math.min;
  const factor = scaleMode(targetWidth / sourceWidth, targetHeight / sourceHeight);
  return {
    a: factor,
    b: 0,
    c: 0,
    d: factor,
    e: (targetWidth - sourceWidth * factor) / 2,
    f: (targetHeight - sourceHeight * factor) / 2,
  };
}

function isRenderableState(state) {
  return Object.values(AVATAR_RUNTIME_STATES).includes(state)
    ? state
    : AVATAR_RUNTIME_STATES.IDLE;
}

function resolveRenderLayers(layers, gesture) {
  const promotedZ = new Map();
  const headZ = layers.find((layer) => layer.id === 'head')?.zIndex ?? 40;
  const facialZ = Math.min(
    ...layers
      .filter((layer) => /^(eyes|mouth)/.test(layer.id))
      .map((layer) => layer.zIndex),
    headZ + 10,
  );
  const zStep = Math.max(0.25, (facialZ - headZ) / 3);
  if (gesture === 'wave') {
    promotedZ.set('armRight', headZ + zStep);
  } else if (gesture === 'celebrate') {
    promotedZ.set('armLeft', headZ + zStep);
    promotedZ.set('armRight', headZ + zStep * 2);
  }

  if (promotedZ.size === 0) return layers;
  return [...layers].sort((left, right) => {
    const leftZ = promotedZ.get(left.id) ?? left.zIndex;
    const rightZ = promotedZ.get(right.id) ?? right.zIndex;
    return leftZ - rightZ || left.zIndex - right.zIndex;
  });
}

class LayeredAvatarRenderer {
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.container = options.container || this.canvas?.parentElement || null;
    this.manifestUrl = options.manifestUrl || DEFAULT_LAYERED_AVATAR_MANIFEST_URL;
    this.loadPackage = options.loadPackage || loadLayeredAvatarPackage;
    this.onError = options.onError || null;
    this.packageDefinition = null;
    this.context = null;
    this.animationFrame = null;
    this.runtimeState = AVATAR_RUNTIME_STATES.IDLE;
    this.targetAudioLevel = 0;
    this.gesture = 'neutral';
    this.gestureStartedAt = 0;
    this.gestureDurationMs = 0;
    this.gestureUntil = 0;
    this.visible = false;
    this.ready = false;
    this.destroyed = false;
    this.lastCssWidth = 0;
    this.lastCssHeight = 0;
    this.devicePixelRatio = 1;
    this.reducedMotionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    this.animator = createAnimatorState(globalThis.performance?.now?.() || 0);
    this.handleVisibilityChange = () => {
      if (globalThis.document?.visibilityState === 'hidden') {
        this.cancelLoop();
      } else if (this.visible && this.ready) {
        this.startLoop();
      }
    };
  }

  async connect() {
    if (this.destroyed || this.packageDefinition) return;
    if (!this.canvas || !this.canvas.getContext) {
      this.reportError(new Error('Avatar Canvas is unavailable.'));
      return;
    }

    this.context = this.canvas.getContext('2d');
    if (!this.context) {
      this.reportError(new Error('Avatar Canvas 2D context is unavailable.'));
      return;
    }

    try {
      this.packageDefinition = await this.loadPackage({
        manifestUrl: this.manifestUrl,
      });
      this.resize(true);
      this.ready = true;
      globalThis.document?.addEventListener?.('visibilitychange', this.handleVisibilityChange);
      this.renderFrame(globalThis.performance?.now?.() || 0);
      if (this.visible) this.startLoop();
    } catch (error) {
      this.ready = false;
      this.reportError(error);
    }
  }

  setState(state) {
    this.runtimeState = isRenderableState(state);
  }

  setAudioLevel(level) {
    const numeric = Number(level);
    this.targetAudioLevel = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0;
  }

  playGesture(name, durationMs) {
    this.gesture = VALID_GESTURES.has(name) ? name : 'neutral';
    if (this.gesture === 'neutral') {
      this.gestureStartedAt = 0;
      this.gestureDurationMs = 0;
      this.gestureUntil = 0;
      return;
    }

    const clipDuration = getGestureDurationMs(this.gesture);
    const requestedDuration = Number(durationMs);
    const duration = Number.isFinite(requestedDuration)
      ? Math.min(4000, Math.max(300, requestedDuration))
      : clipDuration;
    this.gestureStartedAt = globalThis.performance?.now?.() || 0;
    this.gestureDurationMs = duration;
    this.gestureUntil = this.gestureStartedAt + duration;
  }

  show() {
    this.visible = true;
    this.canvas?.removeAttribute?.('hidden');
    if (this.ready) this.startLoop();
  }

  stop() {
    this.setAudioLevel(0);
    this.animator.audioLevel = 0;
    this.animator.mouthState = 'closed';
    this.gesture = 'neutral';
    this.gestureStartedAt = 0;
    this.gestureDurationMs = 0;
    this.gestureUntil = 0;
  }

  resize(force = false) {
    if (!this.canvas || !this.container) return false;

    const rect = this.container.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(
      MAX_DEVICE_PIXEL_RATIO,
      Math.max(1, globalThis.devicePixelRatio || 1),
    );

    if (
      !force &&
      cssWidth === this.lastCssWidth &&
      cssHeight === this.lastCssHeight &&
      dpr === this.devicePixelRatio
    ) {
      return false;
    }

    this.lastCssWidth = cssWidth;
    this.lastCssHeight = cssHeight;
    this.devicePixelRatio = dpr;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    return true;
  }

  renderFrame(timestamp) {
    if (this.destroyed || !this.ready || !this.context || !this.packageDefinition) return;

    try {
      this.resize();
      const context = this.context;
      const dpr = this.devicePixelRatio;
      const width = this.canvas.width;
      const height = this.canvas.height;
      const packageDefinition = this.packageDefinition;
      if (this.gesture !== 'neutral' && timestamp >= this.gestureUntil) {
        this.gesture = 'neutral';
        this.gestureStartedAt = 0;
        this.gestureDurationMs = 0;
        this.gestureUntil = 0;
      }

      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);

      updateAnimator(this.animator, {
        timestamp,
        runtimeState: this.runtimeState,
        targetAudioLevel: this.targetAudioLevel,
        reducedMotion: Boolean(this.reducedMotionQuery?.matches),
        intensity: packageDefinition.manifest.motion.intensity,
        gesture: this.gesture,
        gestureElapsedMs: Math.max(0, timestamp - this.gestureStartedAt),
        gestureDurationMs: this.gestureDurationMs,
        motion: packageDefinition.manifest.motion,
      });

      const localTransforms = createLayerTransforms(this.animator, packageDefinition);
      const fitMatrix = multiply(
        scale(dpr, dpr),
        computeFitMatrix(
          packageDefinition.sourceWidth,
          packageDefinition.sourceHeight,
          this.lastCssWidth,
          this.lastCssHeight,
          packageDefinition.manifest.fit,
        ),
      );
      const worldById = resolveWorldMatrices(
        packageDefinition.layers,
        localTransforms,
        packageDefinition.sourceWidth,
        packageDefinition.sourceHeight,
      );
      const blinkAmount = Number.isFinite(this.animator.blink?.amount)
        ? this.animator.blink.amount
        : (this.animator.blink?.closed ? 1 : 0);
      // Mouth assets are complete vector drawings, so opacity-blending two of
      // them produces a visible double outline. Audio remains smoothed in the
      // animator, but only its dominant mouth pose is rendered per frame.
      const activeMouth = this.animator.mouthState || 'closed';
      const layerOpacity = new Map([
        [packageDefinition.slots.eyes.open, 1 - blinkAmount],
        [packageDefinition.slots.eyes.closed, blinkAmount],
        [packageDefinition.slots.mouth.closed, activeMouth === 'closed' ? 1 : 0],
        [packageDefinition.slots.mouth.small, activeMouth === 'small' ? 1 : 0],
        [packageDefinition.slots.mouth.open, activeMouth === 'open' ? 1 : 0],
      ]);

      for (const layer of resolveRenderLayers(packageDefinition.layers, this.gesture)) {
        const opacity = layerOpacity.get(layer.id) ?? 1;
        if (opacity <= 0.001) continue;
        const world = worldById.get(layer.id) || identityMatrix();
        context.save();
        applyMatrix(context, multiply(fitMatrix, world));
        context.globalAlpha = opacity;
        const layout = layer.layout || { x: 0, y: 0, width: 1, height: 1 };
        context.drawImage(
          layer.image,
          layout.x * packageDefinition.sourceWidth,
          layout.y * packageDefinition.sourceHeight,
          layout.width * packageDefinition.sourceWidth,
          layout.height * packageDefinition.sourceHeight,
        );
        context.restore();
      }

      context.restore();
      this.container?.classList.add('avatar-game-ready');
    } catch (error) {
      this.cancelLoop();
      this.ready = false;
      this.container?.classList.remove('avatar-game-ready');
      this.reportError(error);
    }
  }

  destroy() {
    this.destroyed = true;
    this.cancelLoop();
    globalThis.document?.removeEventListener?.('visibilitychange', this.handleVisibilityChange);
    this.packageDefinition = null;
    this.context = null;
    this.container?.classList.remove('avatar-game-ready');
  }

  startLoop() {
    if (this.animationFrame !== null || this.destroyed) return;
    if (globalThis.document?.visibilityState === 'hidden') return;
    if (typeof globalThis.requestAnimationFrame !== 'function') return;
    this.animationFrame = globalThis.requestAnimationFrame((timestamp) => this.tick(timestamp));
  }

  tick(timestamp) {
    this.animationFrame = null;
    this.renderFrame(timestamp);
    if (this.visible && this.ready) this.startLoop();
  }

  cancelLoop() {
    if (this.animationFrame === null) return;
    globalThis.cancelAnimationFrame?.(this.animationFrame);
    this.animationFrame = null;
  }

  reportError(error) {
    console.warn('Layered avatar unavailable:', error);
    this.container?.classList.remove('avatar-game-ready');
    this.onError?.(error);
  }
}

export function createLayeredAvatarRenderer(options = {}) {
  return new LayeredAvatarRenderer(options);
}
