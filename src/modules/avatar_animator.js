const GESTURE_CLIPS = Object.freeze({
  neutral: Object.freeze({ durationMs: 0, keyframes: Object.freeze([]) }),
  wave: Object.freeze({
    durationMs: 1400,
    keyframes: Object.freeze([
      { at: 0, arm: 0, head: 0, body: 0 },
      { at: 0.18, arm: 1, head: 1, body: 1 },
      { at: 0.34, arm: 0.78, head: 1, body: 1 },
      { at: 0.5, arm: 1, head: 1, body: 1 },
      { at: 0.66, arm: 0.78, head: 1, body: 1 },
      { at: 0.82, arm: 1, head: 1, body: 1 },
      { at: 1, arm: 0, head: 0, body: 0 },
    ]),
  }),
  celebrate: Object.freeze({
    durationMs: 1250,
    keyframes: Object.freeze([
      { at: 0, arms: 0, jump: 0, head: 0 },
      { at: 0.18, arms: 1, jump: 1, head: 1 },
      { at: 0.36, arms: 0.9, jump: 0, head: -0.5 },
      { at: 0.52, arms: 1, jump: 1, head: 1 },
      { at: 0.7, arms: 0.92, jump: 0, head: -0.5 },
      { at: 0.84, arms: 1, jump: 0.7, head: 0.7 },
      { at: 1, arms: 0, jump: 0, head: 0 },
    ]),
  }),
  emphasize: Object.freeze({
    durationMs: 900,
    keyframes: Object.freeze([
      { at: 0, arms: 0, head: 0, body: 0 },
      { at: 0.2, arms: 1, head: 1, body: 1 },
      { at: 0.42, arms: 0.35, head: 0.25, body: 0.2 },
      { at: 0.62, arms: 1, head: 1, body: 0.8 },
      { at: 1, arms: 0, head: 0, body: 0 },
    ]),
  }),
});

const VALID_GESTURES = new Set(Object.keys(GESTURE_CLIPS));
const BASE_MOTION = { breathHz: 0.64, slowHz: 0.27, mediumHz: 0.48, conversationalHz: 0.92 };

function sampleGestureClip(name, elapsedMs, durationMs) {
  const clip = GESTURE_CLIPS[name];
  if (!clip?.keyframes.length) return null;

  const duration = Math.max(1, Number(durationMs) || clip.durationMs);
  const progress = clamp((Number(elapsedMs) || 0) / duration, 0, 1);
  const keyframes = clip.keyframes;
  let right = keyframes.findIndex((keyframe) => keyframe.at >= progress);
  if (right <= 0) return keyframes[0];
  if (right === -1) return keyframes[keyframes.length - 1];

  const from = keyframes[right - 1];
  const to = keyframes[right];
  const amount = easeInOut((progress - from.at) / (to.at - from.at));
  const sample = { at: progress };
  for (const channel of Object.keys(from)) {
    if (channel !== 'at') sample[channel] = mix(from[channel], to[channel], amount);
  }
  return sample;
}

export function getGestureDurationMs(name) {
  return GESTURE_CLIPS[name]?.durationMs || 0;
}

/**
 * Generate transforms for one animation frame.
 *
 * @param {object} input
 * @param {'idle'|'listening'|'thinking'|'speaking'|'error'} input.state
 * @param {'neutral'|'wave'|'celebrate'|'emphasize'} input.gesture
 * @param {number} input.gestureElapsedMs elapsed time since the gesture began
 * @param {number} input.gestureDurationMs optional duration override for the gesture clip
 * @param {number} input.timestamp requestAnimationFrame time in milliseconds
 * @param {number} input.audioLevel normalized Gemini playback energy (0..1)
 * @param {number} input.intensity package motion multiplier (0..2)
 * @param {boolean} input.reducedMotion disable decorative transforms
 * @returns {object} transforms keyed by semantic mascot layer ID
 */
export function generateAnimationFrame(input = {}) {
  const transforms = createTransformSet();
  if (input.reducedMotion) return transforms;

  const runtimeState = VALID_RUNTIME_STATES.has(input.state) ? input.state : 'idle';
  const activeGesture = VALID_GESTURES.has(input.gesture) ? input.gesture : 'neutral';
  const seconds = (Number(input.timestamp) || 0) / 1000;
  const audioLevel = clamp(input.audioLevel, 0, 1);
  const motion = clamp(input.intensity ?? 1, 0, 2);
  const degrees = Math.PI / 180;
  const base = BASE_MOTION;
  const waveDegrees = clamp(
    input.motion?.waveAngle ?? -142,
    -170,
    -30,
  );
  const celebrateDegrees = clamp(
    input.motion?.celebrateAngle ?? 124,
    30,
    150,
  );

  const breath = Math.sin(seconds * Math.PI * 2 * base.breathHz);
  const slow = Math.sin(seconds * Math.PI * 2 * base.slowHz);
  const medium = Math.sin(seconds * Math.PI * 2 * base.mediumHz + 0.7);
  const conversational = Math.sin(seconds * Math.PI * 2 * base.conversationalHz);
  const { body, head, armLeft, armRight, legLeft, legRight } = transforms;

  // Base idle clip. Every runtime state starts from this living neutral pose.
  body.translateY = breath * 0.0045 * motion;
  body.rotation = slow * 0.28 * degrees * motion;
  head.translateY = -breath * 0.003 * motion;
  head.rotation = slow * 0.65 * degrees * motion;
  armLeft.rotation = (-1.5 + medium * 1.1) * degrees * motion;
  armRight.rotation = (1.5 - medium * 1.1) * degrees * motion;
  legLeft.rotation = slow * 0.22 * degrees * motion;
  legRight.rotation = -slow * 0.22 * degrees * motion;

  if (runtimeState === 'listening') {
    body.translateX = medium * 0.004 * motion;
    body.rotation += medium * 0.45 * degrees * motion;
    head.rotation = (medium * 1.6 - 1.2) * degrees * motion;
    armLeft.rotation += (-2.2 + slow * 1.2) * degrees * motion;
    armRight.rotation += (2.2 - slow * 1.2) * degrees * motion;
    legLeft.rotation += medium * 0.45 * degrees * motion;
    legRight.rotation -= medium * 0.45 * degrees * motion;
  } else if (runtimeState === 'thinking') {
    body.translateX = slow * 0.003 * motion;
    body.rotation += slow * 0.55 * degrees * motion;
    head.rotation = (-3.2 + slow * 1.1) * degrees * motion;
    head.translateX = -0.003 * motion;
    armLeft.rotation += (2 + slow) * degrees * motion;
    armRight.rotation += (-10 + medium * 2.2) * degrees * motion;
    legLeft.rotation += 0.55 * degrees * motion;
    legRight.rotation -= 0.35 * degrees * motion;
  } else if (runtimeState === 'speaking') {
    const energy = audioLevel * audioLevel;
    const voiceGesture = conversational * (0.35 + energy * 0.65);
    body.translateY += -energy * 0.006 * motion;
    body.translateX = voiceGesture * 0.0025 * motion;
    body.rotation += voiceGesture * 0.45 * degrees * motion;
    head.rotation = (slow * 0.8 + voiceGesture * 1.2) * degrees * motion;
    head.translateY += -energy * 0.0025 * motion;
    armLeft.rotation += (-3.5 - voiceGesture * (3.5 + energy * 5)) * degrees * motion;
    armRight.rotation += (3.5 - voiceGesture * (3.5 + energy * 5)) * degrees * motion;
    legLeft.rotation += voiceGesture * 0.45 * degrees * motion;
    legRight.rotation -= voiceGesture * 0.45 * degrees * motion;
  } else if (runtimeState === 'error') {
    body.translateX = Math.sin(seconds * Math.PI * 2 * 7) * 0.004 * motion;
    armLeft.rotation -= 4 * degrees * motion;
    armRight.rotation += 4 * degrees * motion;
  }

  // Gemini Live chooses the semantic name. The local clip provides a
  // deterministic start, action, and smooth return to the runtime pose.
  const clip = sampleGestureClip(
    activeGesture,
    input.gestureElapsedMs,
    input.gestureDurationMs,
  );
  if (activeGesture === 'wave' && clip) {
    armRight.rotation += clip.arm * waveDegrees * degrees * motion;
    head.rotation += clip.head * -2 * degrees * motion;
    body.rotation += clip.body * 1.2 * degrees * motion;
  } else if (activeGesture === 'celebrate' && clip) {
    armLeft.rotation += clip.arms * celebrateDegrees * degrees * motion;
    armRight.rotation -= clip.arms * celebrateDegrees * degrees * motion;
    body.translateY -= clip.jump * 0.008 * motion;
    head.rotation += clip.head * 1.4 * degrees * motion;
  } else if (activeGesture === 'emphasize' && clip) {
    armLeft.rotation += clip.arms * 9 * degrees * motion;
    armRight.rotation -= clip.arms * 5 * degrees * motion;
    head.rotation += clip.head * 1.5 * degrees * motion;
    body.translateY -= clip.body * 0.003 * motion;
  }

  return transforms;
}

export const AVATAR_RUNTIME_STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  ERROR: 'error',
});

export const MOUTH_STATES = Object.freeze({
  CLOSED: 'closed', SMALL: 'small', OPEN: 'open',
});

const VALID_RUNTIME_STATES = new Set(Object.values(AVATAR_RUNTIME_STATES));
const DEFAULT_FRAME_MS = 1000 / 60;
const STATE_BLEND_MS = 300;
const BLINK_MIN_MS = 2600;
const BLINK_MAX_MS = 5200;
const BLINK_CLOSE_MS = 55;
const BLINK_HOLD_MS = 45;
const BLINK_OPEN_MS = 90;
const AUDIO_NOISE_GATE = 0.055;
const AUDIO_ATTACK_MS = 38;
const AUDIO_RELEASE_MS = 125;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function mix(from, to, amount) {
  return from + (to - from) * amount;
}

function easeInOut(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function randomBetween(random, min, max) {
  return min + (max - min) * random();
}

function scheduleNextBlink(state, timestamp) {
  state.blink.phase = 'open';
  state.blink.amount = 0;
  state.blink.phaseStartedAt = timestamp;
  state.blink.nextBlinkAt = timestamp + randomBetween(state.random, BLINK_MIN_MS, BLINK_MAX_MS);
}

function identityTransform() {
  return { translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1 };
}

function createTransformSet() {
  return {
    body: identityTransform(),
    head: identityTransform(),
    armLeft: identityTransform(),
    armRight: identityTransform(),
    legLeft: identityTransform(),
    legRight: identityTransform(),
  };
}

function cloneTransformSet(transforms) {
  const clone = createTransformSet();
  for (const [id, transform] of Object.entries(transforms || {})) {
    clone[id] = { ...identityTransform(), ...transform };
  }
  return clone;
}

function blendTransformSets(from, to, amount) {
  const output = createTransformSet();
  for (const id of Object.keys(output)) {
    const left = from[id] || identityTransform();
    const right = to[id] || identityTransform();
    for (const key of Object.keys(output[id])) {
      output[id][key] = mix(left[key], right[key], amount);
    }
  }
  return output;
}

function resolveRuntimeState(value) {
  return VALID_RUNTIME_STATES.has(value) ? value : AVATAR_RUNTIME_STATES.IDLE;
}

function smoothAudio(previous, target, deltaMs) {
  const clampedTarget = clamp(target, 0, 1);
  const gatedTarget = clampedTarget < AUDIO_NOISE_GATE ? 0 : clampedTarget;
  const timeConstant = gatedTarget > previous ? AUDIO_ATTACK_MS : AUDIO_RELEASE_MS;
  const alpha = 1 - Math.exp(-Math.max(0, deltaMs) / timeConstant);
  return previous + (gatedTarget - previous) * alpha;
}

function mouthState(level, speaking) {
  if (!speaking || level < 0.105) return MOUTH_STATES.CLOSED;
  return level < 0.52 ? MOUTH_STATES.SMALL : MOUTH_STATES.OPEN;
}

function updateBlink(state, timestamp, pageVisible) {
  if (!pageVisible) return;
  const blink = state.blink;

  if (blink.phase === 'open') {
    blink.amount = 0;
    if (timestamp >= blink.nextBlinkAt) {
      blink.phase = 'closing';
      blink.phaseStartedAt = timestamp;
    }
    return;
  }

  if (blink.phase === 'closing') {
    const progress = (timestamp - blink.phaseStartedAt) / BLINK_CLOSE_MS;
    blink.amount = easeInOut(progress);
    if (progress >= 1) {
      blink.phase = 'closed';
      blink.phaseStartedAt = timestamp;
      blink.amount = 1;
    }
    return;
  }

  if (blink.phase === 'closed') {
    blink.amount = 1;
    if (timestamp - blink.phaseStartedAt >= BLINK_HOLD_MS) {
      blink.phase = 'opening';
      blink.phaseStartedAt = timestamp;
    }
    return;
  }

  const progress = (timestamp - blink.phaseStartedAt) / BLINK_OPEN_MS;
  blink.amount = 1 - easeInOut(progress);
  if (progress >= 1) scheduleNextBlink(state, timestamp);
}

export function createAnimatorState(now = 0, random = Math.random) {
  const transforms = createTransformSet();
  const state = {
    random,
    runtimeState: AVATAR_RUNTIME_STATES.IDLE,
    stateChangedAt: now,
    lastTimestamp: now,
    transitionFromTransforms: cloneTransformSet(transforms),
    transitionProgress: 1,
    audioLevel: 0,
    mouthState: MOUTH_STATES.CLOSED,
    blink: { phase: 'open', amount: 0, phaseStartedAt: now, nextBlinkAt: 0 },
    transforms,
  };
  scheduleNextBlink(state, now);
  return state;
}

export function updateAnimator(state, input = {}) {
  const timestamp = Number.isFinite(Number(input.timestamp))
    ? Number(input.timestamp)
    : state.lastTimestamp + DEFAULT_FRAME_MS;
  const deltaMs = Math.max(0, timestamp - state.lastTimestamp);
  const runtimeState = resolveRuntimeState(input.runtimeState);

  if (runtimeState !== state.runtimeState) {
    state.runtimeState = runtimeState;
    state.stateChangedAt = timestamp;
    state.transitionFromTransforms = cloneTransformSet(state.transforms);
    state.transitionProgress = 0;
  }

  const speaking = runtimeState === AVATAR_RUNTIME_STATES.SPEAKING;
  state.audioLevel = speaking
    ? smoothAudio(state.audioLevel, input.targetAudioLevel, deltaMs)
    : 0;
  state.mouthState = mouthState(state.audioLevel, speaking);

  updateBlink(state, timestamp, (globalThis.document?.visibilityState || 'visible') !== 'hidden');

  const targetTransforms = generateAnimationFrame({
    state: runtimeState,
    audioLevel: state.audioLevel,
    timestamp,
    reducedMotion: Boolean(input.reducedMotion),
    intensity: input.intensity ?? 1,
    gesture: input.gesture,
    gestureElapsedMs: input.gestureElapsedMs,
    gestureDurationMs: input.gestureDurationMs,
    motion: input.motion,
  });
  state.transitionProgress = clamp((timestamp - state.stateChangedAt) / STATE_BLEND_MS, 0, 1);
  state.transforms = state.transitionProgress < 1
    ? blendTransformSets(state.transitionFromTransforms, targetTransforms, easeInOut(state.transitionProgress))
    : targetTransforms;
  state.lastTimestamp = timestamp;
  return state;
}

export function createLayerTransforms(state, packageDefinition) {
  const layerIds = new Set((packageDefinition?.layers || []).map((layer) => layer.id));
  const transforms = {};
  for (const id of layerIds) transforms[id] = identityTransform();
  for (const [id, transform] of Object.entries(state.transforms || {})) {
    if (layerIds.has(id)) transforms[id] = { ...transforms[id], ...transform };
  }
  return transforms;
}
