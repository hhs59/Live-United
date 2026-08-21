/**
 * Voice state and status presentation.
 *
 * The avatar pixels are rendered by the provider image plus the renderer
 * modules. This module only owns voice state and status presentation.
 */

export const STATES = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  ERROR: 'error',
};

const STATUS_TEXTS = {
  [STATES.IDLE]: '',
  [STATES.LISTENING]: '',
  [STATES.THINKING]: 'Uni is thinking...',
  [STATES.SPEAKING]: 'Speaking...',
  [STATES.ERROR]: 'Something went wrong.',
};

const STATE_LABELS = {
  [STATES.IDLE]: 'READY',
  [STATES.LISTENING]: 'LISTENING',
  [STATES.THINKING]: 'THINKING',
  [STATES.SPEAKING]: 'SPEAKING',
  [STATES.ERROR]: 'ERROR',
};

let currentState = STATES.IDLE;

/** Set the voice state, status text, and CSS state class. */
export function setState(state, customStatusText) {
  if (!Object.values(STATES).includes(state)) {
    console.warn(`Invalid avatar state: ${state}`);
    return;
  }

  currentState = state;
  const container = document.getElementById('avatar-container');
  const statusText = document.getElementById('status-text');
  const soundWave = document.getElementById('sound-wave');
  const stateLabel = document.getElementById('state-label');

  if (!container || !statusText) {
    console.warn('Avatar status DOM elements not found');
    return;
  }

  Object.values(STATES).forEach((candidate) => container.classList.remove(candidate));
  container.classList.add(state);
  statusText.textContent = customStatusText || STATUS_TEXTS[state];
  if (stateLabel) stateLabel.textContent = STATE_LABELS[state];
  soundWave?.classList.toggle('active', state === STATES.LISTENING);
}

export function getState() {
  return currentState;
}
