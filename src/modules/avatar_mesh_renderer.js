/**
 * Small native WebGL2 renderer for the deterministic one-image mesh rig.
 *
 * It owns only WebGL resources and the animation loop. Geometry and motion
 * remain in avatar_mesh.js so they can be tested without a browser.
 */

import { computeImageTransform } from './avatar_geometry.js';
import { createMeshMotionController } from './avatar_mesh.js';

const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision mediump float;
uniform sampler2D uTexture;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uTexture, vUv);
}`;

function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function getDpr() {
  return Math.min(2, Number(typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
}

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch (_) {
    return false;
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader allocation failed.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed.';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program allocation failed.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'WebGL program linking failed.';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function getViewportSize(canvas) {
  const rect = canvas?.getBoundingClientRect?.();
  const parentRect = canvas?.parentElement?.getBoundingClientRect?.();
  // The motion canvas is intentionally hidden until its first valid frame.
  // Use the visual parent while hidden so the first frame is not rendered at
  // a 1x1 backing size and then stretched when it becomes visible.
  const width = rect?.width || parentRect?.width || canvas?.clientWidth || canvas?.width || 1;
  const height = rect?.height || parentRect?.height || canvas?.clientHeight || canvas?.height || 1;
  const dpr = getDpr();
  return {
    cssWidth: width,
    cssHeight: height,
    width: Math.max(1, Math.round(width * dpr)),
    height: Math.max(1, Math.round(height * dpr)),
  };
}

export class AvatarMeshRenderer {
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.image = options.image || null;
    this.rig = options.rig || null;
    this.getViewTransform = options.getViewTransform || null;
    this.onFirstFrame = options.onFirstFrame;
    this.onContextLost = options.onContextLost;
    this.onFrame = options.onFrame;
    this.onError = options.onError;
    this.intensity = options.intensity ?? 1;
    this.gl = null;
    this.program = null;
    this.positionBuffer = null;
    this.uvBuffer = null;
    this.indexBuffer = null;
    this.texture = null;
    this.positionLocation = -1;
    this.uvLocation = -1;
    this.textureLocation = null;
    this.positionBufferInitialized = false;
    this.controller = null;
    this.clipPositions = null;
    this.running = false;
    this.animationFrame = null;
    this.firstFrame = false;
    this.contextLost = false;
    this.failed = false;
    this.errorNotified = false;
    this.listenersAttached = false;
    this.pausedForVisibility = false;
    this.resizeHandler = () => this.resize(true);
    this.visibilityHandler = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        this.pausedForVisibility = this.running || this.pausedForVisibility;
        this.stopLoop();
      } else if (this.pausedForVisibility) {
        this.pausedForVisibility = false;
        this.start();
      }
    };
    this.contextLostHandler = (event) => {
      event.preventDefault?.();
      this.contextLost = true;
      this.stopLoop();
      this.onContextLost?.();
    };
    this.contextRestoredHandler = () => {
      try {
        // WebGL invalidates the old resources while the context is lost. Keep
        // the DOM listeners, rebuild only the GPU objects, and expose the
        // restored canvas again after its first valid frame.
        this.releaseGpuResources(false);
        this.contextLost = false;
        this.failed = false;
        this.errorNotified = false;
        this.firstFrame = false;
        this.initialize();
        if (this.controller) this.start();
      } catch (error) {
        this.notifyError(error);
      }
    };
    try {
      this.initialize();
    } catch (error) {
      this.notifyError(error);
    }
  }

  get available() {
    return Boolean(this.gl && this.program && this.controller &&
      !this.contextLost && !this.failed);
  }

  notifyError(error) {
    if (this.errorNotified) return;
    this.errorNotified = true;
    this.failed = true;
    this.stopLoop();
    this.onError?.(error);
  }

  initialize() {
    if (!this.canvas || typeof this.canvas.getContext !== 'function') return;
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    this.gl = gl;
    this.program = createProgram(gl);
    this.positionBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    if (!this.positionBuffer || !this.uvBuffer || !this.indexBuffer) {
      throw new Error('WebGL mesh buffer allocation failed.');
    }
    this.positionLocation = gl.getAttribLocation(this.program, 'aPosition');
    this.uvLocation = gl.getAttribLocation(this.program, 'aUv');
    this.textureLocation = gl.getUniformLocation(this.program, 'uTexture');
    if (this.positionLocation < 0 || this.uvLocation < 0 || !this.textureLocation) {
      throw new Error('WebGL mesh shader locations are unavailable.');
    }

    if (!this.listenersAttached) {
      this.canvas.addEventListener?.('webglcontextlost', this.contextLostHandler, false);
      this.canvas.addEventListener?.('webglcontextrestored', this.contextRestoredHandler, false);
      if (typeof window !== 'undefined') {
        window.addEventListener?.('resize', this.resizeHandler, { passive: true });
      }
      if (typeof document !== 'undefined') {
        document.addEventListener?.('visibilitychange', this.visibilityHandler);
      }
      this.listenersAttached = true;
    }
    this.configure({ image: this.image, rig: this.rig });
  }

  configure(options = {}) {
    this.image = options.image || this.image;
    this.rig = options.rig || this.rig;
    if (!this.gl || !this.rig || !this.image) return false;
    this.failed = false;
    this.errorNotified = false;
    this.controller = createMeshMotionController(this.rig, {
      intensity: options.intensity ?? this.intensity,
      reducedMotion: options.reducedMotion === undefined
        ? prefersReducedMotion()
        : options.reducedMotion === true,
    });
    if (!this.controller) return false;
    this.clipPositions = new Float32Array(this.controller.getPositions().length);
    this.positionBufferInitialized = false;
    this.uploadStaticBuffers();
    this.uploadTexture();
    this.resize(true);
    return this.renderOnce(0);
  }

  uploadStaticBuffers() {
    const gl = this.gl;
    const geometry = this.controller?.geometry;
    if (!gl || !geometry) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
  }

  uploadTexture() {
    const gl = this.gl;
    if (!gl || !this.image) return;
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    if (!this.texture) throw new Error('WebGL avatar texture allocation failed.');
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei?.(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.image);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(force = false) {
    if (!this.canvas || !this.gl) return;
    const size = getViewportSize(this.canvas);
    if (force || this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
      this.gl.viewport(0, 0, size.width, size.height);
    }
  }

  getTransform() {
    const width = this.canvas?.width || 1;
    const height = this.canvas?.height || 1;
    if (typeof this.getViewTransform === 'function') {
      return this.getViewTransform(width, height);
    }
    return computeImageTransform({
      sourceWidth: this.rig?.sourceWidth || 1,
      sourceHeight: this.rig?.sourceHeight || 1,
      targetWidth: width,
      targetHeight: height,
      fit: 'contain',
      positionX: 0.5,
      positionY: 0.5,
      zoom: 1,
    });
  }

  renderOnce(timestamp = now(), updateController = true) {
    if (!this.available || !this.clipPositions) return false;
    try {
      return this.drawFrame(timestamp, updateController);
    } catch (error) {
      this.notifyError(error);
      return false;
    }
  }

  drawFrame(timestamp, updateController) {
    const gl = this.gl;
    if (updateController) this.controller.update(timestamp);
    const positions = this.controller.getPositions();
    const transform = this.getTransform() || computeImageTransform({
      sourceWidth: this.rig?.sourceWidth || 1,
      sourceHeight: this.rig?.sourceHeight || 1,
      targetWidth: this.canvas?.width || 1,
      targetHeight: this.canvas?.height || 1,
      fit: 'contain',
      positionX: 0.5,
      positionY: 0.5,
      zoom: 1,
    });
    const targetWidth = transform?.targetWidth || this.canvas.width || 1;
    const targetHeight = transform?.targetHeight || this.canvas.height || 1;
    for (let index = 0; index < positions.length; index += 2) {
      const x = transform.offsetX + positions[index] * transform.renderWidth;
      const y = transform.offsetY + positions[index + 1] * transform.renderHeight;
      this.clipPositions[index] = (x / targetWidth) * 2 - 1;
      this.clipPositions[index + 1] = 1 - (y / targetHeight) * 2;
    }

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    if (!this.positionBufferInitialized || typeof gl.bufferSubData !== 'function') {
      gl.bufferData(gl.ARRAY_BUFFER, this.clipPositions, gl.DYNAMIC_DRAW);
      this.positionBufferInitialized = true;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.clipPositions);
    }
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.enableVertexAttribArray(this.uvLocation);
    gl.vertexAttribPointer(this.uvLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.textureLocation, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, this.controller.geometry.indices.length, gl.UNSIGNED_SHORT, 0);
    if (!this.firstFrame) {
      this.firstFrame = true;
      this.onFirstFrame?.();
    }
    this.onFrame?.();
    return true;
  }

  tick = (timestamp) => {
    this.animationFrame = null;
    if (!this.running || this.contextLost) return;
    if (!this.renderOnce(timestamp)) return;
    if (typeof requestAnimationFrame === 'function') {
      this.animationFrame = requestAnimationFrame(this.tick);
    }
  };

  start() {
    if (!this.available) return false;
    if (typeof document !== 'undefined' && document.hidden) {
      this.pausedForVisibility = true;
      return true;
    }
    this.pausedForVisibility = false;
    this.running = true;
    if (typeof requestAnimationFrame === 'function') {
      if (this.animationFrame === null) this.animationFrame = requestAnimationFrame(this.tick);
    } else {
      this.renderOnce(now());
    }
    return true;
  }

  stopLoop() {
    this.running = false;
    if (this.animationFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  stop() {
    this.pausedForVisibility = false;
    this.stopLoop();
    const neutralTimestamp = this.controller?.lastTimestamp ?? now();
    this.controller?.reset();
    // Reset already contains the exact base pose. Draw it without advancing
    // into the idle breathing curve, so Stop is visibly and immediately
    // neutral.
    this.renderOnce(neutralTimestamp, false);
  }

  setState(state) {
    this.controller?.setState(state, now());
    if (!this.running) this.renderOnce(now());
  }

  setAudioLevel(level) {
    this.controller?.setAudioLevel(level);
  }

  releaseGpuResources(deleteResources = true) {
    const gl = this.gl;
    if (gl && deleteResources) {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
      if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
      if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.texture = null;
    this.positionBuffer = null;
    this.uvBuffer = null;
    this.indexBuffer = null;
    this.program = null;
    this.positionLocation = -1;
    this.uvLocation = -1;
    this.textureLocation = null;
    this.positionBufferInitialized = false;
    this.gl = null;
  }

  getHeadTransform() {
    return this.controller?.getHeadTransform?.() || null;
  }

  destroy() {
    this.stopLoop();
    if (this.listenersAttached) {
      if (typeof window !== 'undefined') window.removeEventListener?.('resize', this.resizeHandler);
      if (typeof document !== 'undefined') {
        document.removeEventListener?.('visibilitychange', this.visibilityHandler);
      }
      this.canvas?.removeEventListener?.('webglcontextlost', this.contextLostHandler);
      this.canvas?.removeEventListener?.('webglcontextrestored', this.contextRestoredHandler);
    }
    this.listenersAttached = false;
    this.releaseGpuResources(true);
    this.controller = null;
    this.canvas = null;
  }
}

export function createAvatarMeshRenderer(options = {}) {
  return new AvatarMeshRenderer(options);
}
