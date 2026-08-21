/**
 * Provider-independent single-image avatar facade.
 *
 * The provider image is the authoritative texture. When a validated package
 * and WebGL2 are available, a small mesh renders it; otherwise the HTML image
 * remains visible. The adaptive mouth is a transparent Canvas overlay driven
 * by playback audio. Preparation never runs during a response.
 */

import {
  AVATAR_MANIFEST_URL,
  AVATAR_ANALYSIS_VERSION,
  AVATAR_PREPARATION_VERSION,
  createMeshRigFromGeometry,
  loadAvatarRig,
  loadAvatarDefinition,
  readCachedAvatarPreparation,
  writeCachedAvatarPreparation,
} from './avatar_config.js';
import {
  deriveManualSafeRig,
  prepareAvatarImage,
  validatePreparedAvatarGeometry,
} from './avatar_detection.js';
import { computeImageTransform } from './avatar_geometry.js';
import { createAvatarMeshRenderer } from './avatar_mesh_renderer.js';
import {
  DEFAULT_MOUTH_COLORS,
  deriveMouthColors,
  createAvatarRig,
  createAdaptiveTextureMouthRenderer,
} from './avatar_mouth.js';

function getImageData(image, width, height) {
  if (!image || typeof document === 'undefined') return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } catch (_) {
    return null;
  }
}

function deriveColors(image, mouthBox, overrides) {
  const sourceWidth = image?.naturalWidth || image?.width || 1;
  const sourceHeight = image?.naturalHeight || image?.height || 1;
  const sampleScale = Math.min(1, 1024 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * sampleScale));
  const height = Math.max(1, Math.round(sourceHeight * sampleScale));
  const imageData = getImageData(image, width, height);

  if (!imageData) {
    return {
      colors: { ...DEFAULT_MOUTH_COLORS, ...(overrides || {}) },
      usedFallback: true,
    };
  }

  return {
    colors: deriveMouthColors(imageData, mouthBox, overrides),
    usedFallback: false,
  };
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown avatar error.');
}

function setStyleValue(element, property, value) {
  if (!element?.style) return;
  if (typeof element.style.setProperty === 'function' && property.includes('-')) {
    element.style.setProperty(property, value);
  } else {
    element.style[property] = value;
  }
}

function setStyleIfChanged(element, property, value, cache) {
  if (!element?.style || cache[property] === value) return;
  if (typeof element.style.setProperty === 'function' && property.includes('-')) {
    element.style.setProperty(property, value);
  } else {
    element.style[property] = value;
  }
  cache[property] = value;
}

function mergeSuggestedView(manifest, suggestedView) {
  if (!suggestedView) return { ...manifest.view };
  const explicit = manifest.viewOverrides || {};
  return {
    ...manifest.view,
    positionX: explicit.positionX === true ? manifest.view.positionX : suggestedView.positionX,
    positionY: explicit.positionY === true ? manifest.view.positionY : suggestedView.positionY,
    zoom: explicit.zoom === true ? manifest.view.zoom : suggestedView.zoom,
  };
}

export class AvatarRenderer {
  constructor(options = {}) {
    this.baseImage = options.baseImage || null;
    this.motionCanvas = options.motionCanvas || null;
    this.mouthCanvas = options.mouthCanvas || null;
    this.visual = options.visual || this.mouthCanvas?.parentElement || null;
    this.manifestUrl = options.manifestUrl || AVATAR_MANIFEST_URL;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.mouthRenderer = createAdaptiveTextureMouthRenderer({
      canvas: this.mouthCanvas,
      deformationProvider: () => this.meshRenderer?.getHeadTransform?.() || null,
    });
    this.meshRenderer = null;
    this.meshRig = null;
    this.meshReady = false;
    this.meshFailed = false;
    this.definition = null;
    this.rig = null;
    this.view = null;
    this.ready = false;
    this.failed = false;
    this.speaking = false;
    this.pendingLevel = 0;
    this.connectPromise = null;
    this.rigPromise = null;
    this.baseStyleCache = Object.create(null);
    this.resizeObserver = null;
    this.resizeHandler = null;
    this.prepareAbortController = null;
    this.destroyed = false;
  }

  async connect() {
    if (this.ready) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.initialize().catch((error) => {
      this.failed = true;
      this.onStatus?.({ state: 'unavailable', reason: safeErrorMessage(error) });
      this.onError?.(error);
      throw error;
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async initialize() {
    this.definition = await loadAvatarDefinition({ manifestUrl: this.manifestUrl });
    this.view = { ...this.definition.manifest.view };
    this.showBaseImage(this.definition.imageUrl);
    this.hideMesh();
    this.applyBaseImageTransform();

    this.ready = true;
    this.onStatus?.({ state: 'ready', renderer: 'single-image-mesh-canvas' });

    this.observeResize();

    // The base image is ready immediately. Detection and palette preparation
    // happen in parallel and never delay voice connection or playback.
    this.prepareRig();
  }

  observeResize() {
    this.resizeHandler = () => {
      this.applyBaseImageTransform();
      this.meshRenderer?.resize?.(true);
      this.mouthRenderer.resize(true);
      this.mouthRenderer.render();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener?.('resize', this.resizeHandler, { passive: true });
    }
    if (typeof ResizeObserver !== 'undefined' && this.visual) {
      this.resizeObserver = new ResizeObserver(this.resizeHandler);
      this.resizeObserver.observe(this.visual);
    }
  }

  getViewportSize(backingStore = false) {
    const rect = this.visual?.getBoundingClientRect?.();
    const cssWidth = rect?.width || this.mouthCanvas?.clientWidth || 1;
    const cssHeight = rect?.height || this.mouthCanvas?.clientHeight || 1;
    if (!backingStore) return { width: cssWidth, height: cssHeight };

    const pixelRatio = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    return {
      width: Math.max(1, Math.round(cssWidth * pixelRatio)),
      height: Math.max(1, Math.round(cssHeight * pixelRatio)),
    };
  }

  getTransform() {
    const dimensions = this.definition
      ? { width: this.definition.sourceWidth, height: this.definition.sourceHeight }
      : { width: 1, height: 1 };
    const target = this.getViewportSize(true);
    return computeImageTransform({
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      targetWidth: target.width,
      targetHeight: target.height,
      ...this.view,
    });
  }

  getBaseTransform() {
    const dimensions = this.definition
      ? { width: this.definition.sourceWidth, height: this.definition.sourceHeight }
      : { width: 1, height: 1 };
    const target = this.getViewportSize(false);
    return computeImageTransform({
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      targetWidth: target.width,
      targetHeight: target.height,
      ...this.view,
    });
  }

  applyBaseImageTransform() {
    if (!this.baseImage || !this.definition) return;
    const transform = this.getBaseTransform();
    const style = this.baseImage.style;
    if (!style) return;

    // Set explicit rendered dimensions so CSS and Canvas share the exact same
    // non-centered fit/position/zoom math.
    setStyleIfChanged(this.baseImage, 'position', 'absolute', this.baseStyleCache);
    setStyleIfChanged(this.baseImage, 'inset', 'auto', this.baseStyleCache);
    setStyleIfChanged(this.baseImage, 'left', `${transform.offsetX}px`, this.baseStyleCache);
    setStyleIfChanged(this.baseImage, 'top', `${transform.offsetY}px`, this.baseStyleCache);
    setStyleIfChanged(this.baseImage, 'width', `${transform.renderWidth}px`, this.baseStyleCache);
    setStyleIfChanged(this.baseImage, 'height', `${transform.renderHeight}px`, this.baseStyleCache);
    setStyleIfChanged(this.baseImage, 'object-fit', 'fill', this.baseStyleCache);
    setStyleIfChanged(this.baseImage, 'object-position', 'center', this.baseStyleCache);
    setStyleValue(this.baseImage, 'transform', 'none');
    setStyleValue(this.baseImage, 'transformOrigin', 'center');
    setStyleValue(this.baseImage, 'borderRadius', '0');
  }

  async prepareRig() {
    if (this.rigPromise || !this.definition) return this.rigPromise;

    const definition = this.definition;
    this.rigPromise = (async () => {
      const {
        manifest,
        image,
        imageBytes,
        mimeType,
        imageHash,
        automaticEligible,
      } = definition;
      let safeRig = null;
      let source = null;
      let colors = null;
      let meshRig = null;
      let preparation = null;
      const bodyMode = manifest.motion?.mode || 'off';
      const bodyNeedsPreparation = bodyMode === 'auto';
      const mouthNeedsPreparation = manifest.mouth.mode === 'auto' && !manifest.mouth.box;

      if (bodyMode === 'mesh') {
        try {
          meshRig = await loadAvatarRig(this.definition);
          this.meshRig = meshRig;
          if (this.destroyed) return;
        } catch (error) {
          this.meshFailed = true;
          this.onStatus?.({ state: 'mesh-static', reason: safeErrorMessage(error) });
          console.warn('Avatar mesh rig is unavailable; using the static image.', error);
        }
      }

      if (meshRig?.mouthBox && mouthNeedsPreparation) {
        // A generated package already contains the mouth observation. Do not
        // spend another vision request for ordinary users.
        safeRig = deriveManualSafeRig(meshRig.mouthBox);
        source = 'mesh-package';
      } else if (manifest.mouth.box) {
        safeRig = deriveManualSafeRig(manifest.mouth.box);
        source = 'manual';
      }

      const needsPreparation = (bodyNeedsPreparation && !meshRig) ||
        (mouthNeedsPreparation && !safeRig);
      if (needsPreparation && !automaticEligible) {
        this.onStatus?.({ state: 'static', reason: 'image-too-small' });
        console.warn('Automatic avatar preparation needs a 512px shortest side.');
      } else if (needsPreparation) {
        if (imageHash) {
          const cached = readCachedAvatarPreparation(imageHash);
          if (cached) {
            preparation = validatePreparedAvatarGeometry({
              version: AVATAR_PREPARATION_VERSION,
              analysisVersion: AVATAR_ANALYSIS_VERSION,
              sourceHash: cached.sourceHash,
              cacheHit: true,
              geometry: cached.geometry,
            }, imageHash);
            if (preparation) {
              this.onStatus?.({ state: 'preparation-cache-hit' });
            }
          }
        }

        if (!preparation) {
          this.onStatus?.({ state: 'preparing-avatar', source: 'gemini-vision' });
          this.prepareAbortController = typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;
          preparation = await prepareAvatarImage({
            imageBytes,
            mimeType,
            expectedSourceHash: imageHash,
            signal: this.prepareAbortController?.signal,
          });
          if (this.destroyed) return;
          if (!preparation.ok) {
            const state = preparation.reason === 'quota'
              ? 'analysis-quota'
              : preparation.reason === 'not-detected'
                ? 'needs-calibration'
                : 'static';
            this.onStatus?.({ state, reason: preparation.reason });
            console.warn(`Avatar preparation did not produce safe geometry (${preparation.reason}).`);
            preparation = null;
          } else if (!imageHash && preparation.sourceHash) {
            // Subtle crypto is unavailable only in older/insecure contexts.
            // The backend hash is still authoritative for this page session;
            // it is safe to cache only after the backend has computed it.
            definition.imageHash = preparation.sourceHash;
          }
          if (preparation?.ok && definition.imageHash) {
            writeCachedAvatarPreparation(definition.imageHash, preparation.rawGeometry);
          }
        }
      }

      if (preparation) {
        if (bodyNeedsPreparation && !meshRig && preparation.meshGeometry) {
          meshRig = createMeshRigFromGeometry(definition, preparation.meshGeometry);
          this.meshRig = meshRig;
          if (!meshRig) this.onStatus?.({ state: 'mesh-static', reason: 'invalid-body-geometry' });
        }
        if (mouthNeedsPreparation && !safeRig && preparation.safeRig) {
          safeRig = preparation.safeRig;
          source = preparation.cacheHit ? 'preparation-cache' : 'gemini-vision';
        }
      }

      if (bodyNeedsPreparation && !meshRig) {
        this.onStatus?.({ state: 'mesh-static', reason: 'body-unavailable' });
      }
      if (mouthNeedsPreparation && !safeRig) {
        this.onStatus?.({ state: 'needs-calibration', reason: 'mouth-unavailable' });
      }

      if (safeRig?.mouthBox && safeRig.safeRegion) {
        if (!colors) {
          const colorResult = deriveColors(image, safeRig.mouthBox, manifest.mouth.colors);
          colors = colorResult.colors;
          if (colorResult.usedFallback) {
            this.onStatus?.({ state: 'colors-fallback', reason: 'unavailable' });
            console.warn('Avatar mouth color sampling was unavailable; using preset colors.');
          }
        }

        const rig = createAvatarRig({
          ...safeRig,
          rigVersion: 4,
          analysisVersion: 2,
          sourceWidth: this.definition.sourceWidth,
          sourceHeight: this.definition.sourceHeight,
          source,
          colors,
          style: manifest.mouth.style,
          analyzerModel: preparation?.geometry?.model || safeRig.analyzerModel,
          confidence: preparation?.geometry?.confidence ?? safeRig.confidence,
        });
        if (rig && this.mouthRenderer.available) {
          this.rig = rig;
          if (rig.suggestedView) {
            this.view = mergeSuggestedView(manifest, rig.suggestedView);
            this.applyBaseImageTransform();
          }
          this.mouthRenderer.configure({
            image,
            mouthBox: rig.mouthBox,
            colors,
            rig: this.rig,
            transformProvider: () => this.getTransform(),
            deformationProvider: () => this.meshRenderer?.getHeadTransform?.() || null,
          });
          this.mouthRenderer.setAudioLevel(this.pendingLevel);
          if (this.speaking) this.mouthRenderer.startSpeaking();

          this.onStatus?.({ state: 'mouth-ready', source });
        }
      }

      if (meshRig && !this.meshFailed) {
        this.setupMeshRenderer(meshRig, manifest.motion, bodyMode === 'auto' ? 'gemini-vision-auto' : 'package');
      }
    })().catch((error) => {
      this.onStatus?.({ state: 'static', reason: safeErrorMessage(error) });
      console.warn('Avatar mouth setup failed; keeping the static avatar.', error);
    }).finally(() => {
      definition.imageBytes = null;
      this.prepareAbortController = null;
    });

    return this.rigPromise;
  }

  setupMeshRenderer(meshRig, motion, source = 'package') {
    if (!this.motionCanvas || !this.definition?.image) {
      this.onStatus?.({ state: 'mesh-static', reason: 'canvas-unavailable' });
      return;
    }
    this.hideMesh();
    try {
      this.meshRenderer?.destroy?.();
      this.meshRenderer = createAvatarMeshRenderer({
        canvas: this.motionCanvas,
        image: this.definition.image,
        rig: meshRig,
        intensity: motion?.intensity,
        getViewTransform: () => this.getTransform(),
        onFirstFrame: () => {
          if (this.destroyed) return;
          this.meshReady = true;
          this.meshFailed = false;
          this.showMesh();
          this.onStatus?.({ state: 'mesh-ready', source });
        },
        onContextLost: () => {
          this.meshReady = false;
          this.meshFailed = true;
          this.hideMesh();
          this.onStatus?.({ state: 'mesh-static', reason: 'context-lost' });
        },
        onFrame: () => this.mouthRenderer.render(),
        onError: (error) => {
          this.meshReady = false;
          this.meshFailed = true;
          this.hideMesh();
          console.warn('Avatar mesh renderer failed; using the static image.', error);
        },
      });
      if (!this.meshRenderer.available) {
        this.meshFailed = true;
        this.hideMesh();
        this.onStatus?.({ state: 'mesh-static', reason: 'webgl2-unavailable' });
        return;
      }
      this.meshRenderer.setState(this.visual?.dataset?.avatarState || 'idle');
      this.meshRenderer.setAudioLevel(this.pendingLevel);
      this.meshRenderer.start();
    } catch (error) {
      this.meshReady = false;
      this.meshFailed = true;
      this.hideMesh();
      this.onStatus?.({ state: 'mesh-static', reason: safeErrorMessage(error) });
      console.warn('Avatar mesh setup failed; using the static image.', error);
    }
  }

  setState(state) {
    const normalized = state || 'idle';
    if (this.visual) this.visual.dataset.avatarState = normalized;
    this.meshRenderer?.setState?.(normalized);
    if (normalized !== 'error') this.meshRenderer?.start?.();
  }

  startSpeaking() {
    this.speaking = true;
    this.mouthRenderer.startSpeaking();
    this.meshRenderer?.setState?.('speaking');
    this.meshRenderer?.start?.();
  }

  setAudioLevel(level) {
    const numericLevel = Number(level);
    this.pendingLevel = Number.isFinite(numericLevel)
      ? Math.min(1, Math.max(0, numericLevel))
      : 0;
    this.mouthRenderer.setAudioLevel(this.pendingLevel);
    this.meshRenderer?.setAudioLevel?.(this.pendingLevel);
  }

  stop() {
    this.speaking = false;
    this.pendingLevel = 0;
    this.mouthRenderer.stop();
    this.meshRenderer?.stop?.();
  }

  show() {
    this.showBaseImage(this.definition?.imageUrl);
    this.applyBaseImageTransform();
    if (this.meshReady) {
      this.showMesh();
    } else if (this.mouthCanvas) {
      this.mouthCanvas.hidden = false;
      this.visual?.classList.add('avatar-single-image-active');
    }
  }

  hide() {
    this.hideMesh();
    if (this.baseImage) this.baseImage.hidden = true;
    if (this.mouthCanvas) {
      this.mouthCanvas.hidden = true;
      this.visual?.classList.remove('avatar-single-image-active');
    }
  }

  showBaseImage(imageUrl) {
    if (!this.baseImage || !imageUrl) return;
    if (this.baseImage.src !== imageUrl) this.baseImage.src = imageUrl;
    this.baseImage.hidden = false;
  }

  showMesh() {
    if (!this.motionCanvas) return;
    this.motionCanvas.hidden = false;
    if (this.baseImage) this.baseImage.hidden = true;
    this.visual?.classList.add('avatar-single-image-active');
    this.visual?.parentElement?.classList.add('avatar-mesh-active');
  }

  hideMesh() {
    if (this.motionCanvas) this.motionCanvas.hidden = true;
    if (this.baseImage) this.baseImage.hidden = false;
    this.visual?.parentElement?.classList.remove('avatar-mesh-active');
  }

  destroy() {
    this.destroyed = true;
    this.prepareAbortController?.abort?.();
    this.stop();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.resizeHandler && typeof window !== 'undefined') {
      window.removeEventListener?.('resize', this.resizeHandler);
    }
    this.mouthRenderer.destroy();
    this.meshRenderer?.destroy?.();
    this.meshRenderer = null;
    this.definition = null;
    this.rig = null;
    this.view = null;
    this.ready = false;
    this.rigPromise = null;
  }
}

export function createAvatarRenderer(options = {}) {
  return new AvatarRenderer(options);
}
