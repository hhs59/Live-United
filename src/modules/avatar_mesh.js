/**
 * Pure one-image avatar mesh construction and motion math.
 *
 * This module intentionally has no DOM, WebGL, network, or storage access.
 * The provider image remains the texture; this code only moves a small grid.
 */

export const MESH_COLUMNS = 13;
export const MESH_ROWS = 13;
export const MESH_VERTEX_COUNT = MESH_COLUMNS * MESH_ROWS;
export const MESH_TRIANGLE_COUNT = (MESH_COLUMNS - 1) * (MESH_ROWS - 1) * 2;
export const MAX_DISPLACEMENT = 0.015;
export const MAX_HEAD_ROTATION = 2 * Math.PI / 180;
export const MAX_TORSO_ROTATION = 1 * Math.PI / 180;
export const MOTION_PRESET = 'subtle-v1';

const TAU = Math.PI * 2;
const VALID_STATES = new Set(['idle', 'listening', 'thinking', 'speaking', 'error']);

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boxEdges(box) {
  if (!box) return null;
  return {
    left: box.x - box.width / 2,
    top: box.y - box.height / 2,
    right: box.x + box.width / 2,
    bottom: box.y + box.height / 2,
  };
}

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function boxWeight(x, y, box, feather) {
  const edges = boxEdges(box);
  if (!edges) return 0;
  const outsideX = Math.max(edges.left - x, 0, x - edges.right);
  const outsideY = Math.max(edges.top - y, 0, y - edges.bottom);
  const distance = Math.hypot(outsideX, outsideY);
  return 1 - smoothstep(0, Math.max(0.0001, feather), distance);
}

function normalizeState(state) {
  const normalized = String(state || 'idle').toLowerCase();
  return VALID_STATES.has(normalized) ? normalized : 'idle';
}

function transformPoint(point, pivot, transform) {
  const scaleX = finite(transform.scaleX, 1);
  const scaleY = finite(transform.scaleY, 1);
  const rotation = finite(transform.rotation, 0);
  const scaledX = (point.x - pivot.x) * scaleX;
  const scaledY = (point.y - pivot.y) * scaleY;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return {
    x: pivot.x + scaledX * cosine - scaledY * sine + finite(transform.translateX),
    y: pivot.y + scaledX * sine + scaledY * cosine + finite(transform.translateY),
  };
}

function basePose() {
  return {
    head: { translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    torso: { translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  };
}

function statePose(state, seconds, audioLevel, intensity, reducedMotion) {
  const pose = basePose();
  if (reducedMotion || state === 'error') return pose;
  const amount = clamp(intensity, 0.5, 1.25);
  const audio = clamp(audioLevel);
  const breath = Math.sin(seconds * TAU / 2.8);
  const headFloat = Math.sin(seconds * TAU / 2.8 - 0.32);

  pose.torso.translateY = breath * 0.0035 * amount;
  pose.torso.scaleY = 1 + breath * 0.003 * amount;
  pose.head.translateY = headFloat * 0.002 * amount;
  pose.head.rotation = Math.sin(seconds * TAU / 3.1 - 0.3) * 0.35 * Math.PI / 180 * amount;

  if (state === 'listening') {
    pose.torso.translateX += Math.sin(seconds * TAU / 2.2) * 0.0045 * amount;
    pose.head.translateX += Math.sin(seconds * TAU / 2.2 - 0.5) * 0.003 * amount;
    pose.head.rotation += Math.sin(seconds * TAU / 2.5) * 0.7 * Math.PI / 180 * amount;
  } else if (state === 'thinking') {
    pose.torso.translateX += Math.sin(seconds * TAU / 3.4) * 0.0035 * amount;
    pose.head.translateX += Math.sin(seconds * TAU / 3.4 - 0.4) * 0.0055 * amount;
    pose.head.rotation += Math.sin(seconds * TAU / 3.4) * 1.2 * Math.PI / 180 * amount;
  } else if (state === 'speaking') {
    const energy = audio * audio;
    pose.torso.translateY += energy * 0.003 * amount;
    pose.head.translateY += energy * 0.002 * amount;
    pose.head.rotation += Math.sin(seconds * TAU / 1.9) * energy * 1 * Math.PI / 180 * amount;
  }

  pose.head.translateX = clamp(pose.head.translateX, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
  pose.head.translateY = clamp(pose.head.translateY, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
  pose.torso.translateX = clamp(pose.torso.translateX, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
  pose.torso.translateY = clamp(pose.torso.translateY, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
  pose.head.rotation = clamp(pose.head.rotation, -MAX_HEAD_ROTATION, MAX_HEAD_ROTATION);
  pose.torso.rotation = clamp(pose.torso.rotation, -MAX_TORSO_ROTATION, MAX_TORSO_ROTATION);
  pose.head.scaleX = clamp(pose.head.scaleX, 0.985, 1.015);
  pose.head.scaleY = clamp(pose.head.scaleY, 0.985, 1.015);
  pose.torso.scaleX = clamp(pose.torso.scaleX, 0.985, 1.015);
  pose.torso.scaleY = clamp(pose.torso.scaleY, 0.985, 1.015);
  return pose;
}

function copyPose(pose) {
  return {
    head: { ...pose.head },
    torso: { ...pose.torso },
  };
}

function blendPose(from, to, amount) {
  const mix = clamp(amount);
  const blendTransform = (left, right) => Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key] + (right[key] - left[key]) * mix]),
  );
  return {
    head: blendTransform(from.head, to.head),
    torso: blendTransform(from.torso, to.torso),
  };
}

/**
 * Build the fixed regular grid and deterministic region weights.
 */
export function buildMeshGeometry(rig) {
  if (!rig?.characterBox || !rig?.headBox || !rig?.torsoBox ||
      !rig?.neckPoint || !rig?.rootPoint) return null;

  const positions = new Float32Array(MESH_VERTEX_COUNT * 2);
  const basePositions = new Float32Array(MESH_VERTEX_COUNT * 2);
  const uvs = new Float32Array(MESH_VERTEX_COUNT * 2);
  const headWeights = new Float32Array(MESH_VERTEX_COUNT);
  const torsoWeights = new Float32Array(MESH_VERTEX_COUNT);
  const rootLocks = new Float32Array(MESH_VERTEX_COUNT);
  const indices = new Uint16Array(MESH_TRIANGLE_COUNT * 3);
  const character = boxEdges(rig.characterBox);
  const rootHeight = 0.14;
  const rootRadius = rootHeight * 0.75;
  let vertex = 0;
  for (let row = 0; row < MESH_ROWS; row += 1) {
    const y = row / (MESH_ROWS - 1);
    for (let column = 0; column < MESH_COLUMNS; column += 1) {
      const x = column / (MESH_COLUMNS - 1);
      const offset = vertex * 2;
      positions[offset] = x;
      positions[offset + 1] = y;
      basePositions[offset] = x;
      basePositions[offset + 1] = y;
      uvs[offset] = x;
      uvs[offset + 1] = y;

      const background = boxWeight(x, y, rig.characterBox, 0.08);
      const rawHeadWeight = boxWeight(x, y, rig.headBox, 0.06) * background;
      const rawTorsoWeight = boxWeight(x, y, rig.torsoBox, 0.08) * background;
      const regionWeight = rawHeadWeight + rawTorsoWeight;
      headWeights[vertex] = regionWeight > 1
        ? rawHeadWeight / regionWeight
        : rawHeadWeight;
      torsoWeights[vertex] = regionWeight > 1
        ? rawTorsoWeight / regionWeight
        : rawTorsoWeight;
      const anchorStart = character.bottom - rootHeight;
      const bottomLock = x >= character.left && x <= character.right
        ? smoothstep(anchorStart, character.bottom, y)
        : 0;
      // The explicit root point is the provider/model-independent anchor.
      // The bottom band protects the whole support area while this radial
      // lock keeps the declared support point stable on coarse grid rows.
      const rootLock = 1 - smoothstep(
        0,
        rootRadius,
        Math.hypot(x - rig.rootPoint.x, y - rig.rootPoint.y),
      );
      rootLocks[vertex] = Math.max(bottomLock, rootLock);
      vertex += 1;
    }
  }

  let index = 0;
  for (let row = 0; row < MESH_ROWS - 1; row += 1) {
    for (let column = 0; column < MESH_COLUMNS - 1; column += 1) {
      const topLeft = row * MESH_COLUMNS + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + MESH_COLUMNS;
      const bottomRight = bottomLeft + 1;
      indices[index++] = topLeft;
      indices[index++] = bottomLeft;
      indices[index++] = topRight;
      indices[index++] = topRight;
      indices[index++] = bottomLeft;
      indices[index++] = bottomRight;
    }
  }

  return {
    columns: MESH_COLUMNS,
    rows: MESH_ROWS,
    positions,
    basePositions,
    uvs,
    indices,
    headWeights,
    torsoWeights,
    rootLocks,
  };
}

export class MeshMotionController {
  constructor(rig, options = {}) {
    this.rig = rig;
    this.geometry = buildMeshGeometry(rig);
    this.state = 'idle';
    this.intensity = clamp(options.intensity ?? 1, 0.5, 1.25);
    this.reducedMotion = options.reducedMotion === true;
    this.targetAudio = 0;
    this.audio = 0;
    this.lastTimestamp = 0;
    this.stateStarted = 0;
    this.transitionDuration = 320;
    this.fromPose = basePose();
    this.pose = basePose();
    this.headTransform = {
      pivotX: rig?.neckPoint?.x || 0.5,
      pivotY: rig?.neckPoint?.y || 0.5,
      translateX: 0,
      translateY: 0,
      rotationRadians: 0,
      scaleX: 1,
      scaleY: 1,
    };
  }

  setState(state, timestamp = this.lastTimestamp) {
    const next = normalizeState(state);
    if (next === this.state) return;
    this.pose = this.update(timestamp);
    this.fromPose = copyPose(this.pose);
    this.state = next;
    this.stateStarted = finite(timestamp, this.lastTimestamp);
  }

  setAudioLevel(level) {
    this.targetAudio = clamp(level);
  }

  update(timestamp = 0) {
    const now = Math.max(0, finite(timestamp, this.lastTimestamp));
    const delta = Math.min(0.1, Math.max(0, (now - this.lastTimestamp) / 1000));
    const audioCoefficient = 1 - Math.exp(-delta * 14);
    this.audio += (this.targetAudio - this.audio) * (delta > 0 ? audioCoefficient : 1);
    this.lastTimestamp = now;
    const seconds = Math.max(0, (now - this.stateStarted) / 1000);
    const target = statePose(this.state, seconds, this.audio, this.intensity, this.reducedMotion);
    const transition = this.state === 'idle' && this.stateStarted === 0
      ? 1
      : smoothstep(0, 1, Math.min(1, (now - this.stateStarted) / this.transitionDuration));
    this.pose = blendPose(this.fromPose, target, transition);
    this.applyToPositions();
    this.headTransform = {
      pivotX: this.rig.neckPoint.x,
      pivotY: this.rig.neckPoint.y,
      translateX: this.pose.head.translateX,
      translateY: this.pose.head.translateY,
      rotationRadians: this.pose.head.rotation,
      scaleX: this.pose.head.scaleX,
      scaleY: this.pose.head.scaleY,
    };
    return this.pose;
  }

  applyToPositions() {
    if (!this.geometry) return;
    const { basePositions, positions, headWeights, torsoWeights, rootLocks } = this.geometry;
    const headPivot = this.rig.neckPoint;
    const torsoPivot = {
      x: this.rig.torsoBox.x,
      y: this.rig.torsoBox.y - this.rig.torsoBox.height * 0.42,
    };
    for (let vertex = 0; vertex < MESH_VERTEX_COUNT; vertex += 1) {
      const offset = vertex * 2;
      const base = { x: basePositions[offset], y: basePositions[offset + 1] };
      const headWeight = headWeights[vertex];
      const torsoWeight = torsoWeights[vertex];
      const total = headWeight + torsoWeight;
      const normalizedHead = total > 1 ? headWeight / total : headWeight;
      const normalizedTorso = total > 1 ? torsoWeight / total : torsoWeight;
      const headPoint = transformPoint(base, headPivot, this.pose.head);
      const torsoPoint = transformPoint(base, torsoPivot, this.pose.torso);
      let x = base.x * (1 - normalizedHead - normalizedTorso) +
        headPoint.x * normalizedHead + torsoPoint.x * normalizedTorso;
      let y = base.y * (1 - normalizedHead - normalizedTorso) +
        headPoint.y * normalizedHead + torsoPoint.y * normalizedTorso;
      const rootLock = clamp(rootLocks[vertex]);
      x = base.x + (x - base.x) * (1 - rootLock);
      y = base.y + (y - base.y) * (1 - rootLock);
      positions[offset] = base.x + clamp(x - base.x, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
      positions[offset + 1] = base.y + clamp(y - base.y, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
    }
  }

  getPositions() {
    return this.geometry?.positions || new Float32Array();
  }

  getHeadTransform() {
    return { ...this.headTransform };
  }

  reset() {
    this.state = 'idle';
    this.targetAudio = 0;
    this.audio = 0;
    this.fromPose = basePose();
    this.pose = basePose();
    this.stateStarted = this.lastTimestamp;
    this.applyToPositions();
    this.headTransform = {
      pivotX: this.rig.neckPoint.x,
      pivotY: this.rig.neckPoint.y,
      translateX: 0,
      translateY: 0,
      rotationRadians: 0,
      scaleX: 1,
      scaleY: 1,
    };
  }
}

export function createMeshMotionController(rig, options = {}) {
  if (!buildMeshGeometry(rig)) return null;
  return new MeshMotionController(rig, options);
}
