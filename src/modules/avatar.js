/**
 * Avatar states enum.
 */
export const STATES = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  ERROR: 'error',
};

/**
 * Map states to avatar image paths.
 */
const IMAGES = {
  [STATES.IDLE]: 'assets/uni-idle.jpg',
  [STATES.LISTENING]: 'assets/uni-listening.jpg',
  [STATES.THINKING]: 'assets/uni-thinking.jpg',
  [STATES.SPEAKING]: 'assets/uni-speaking.jpg',
  [STATES.ERROR]: 'assets/uni-error.jpg',
};

/**
 * Map states to status text messages.
 */
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

/**
 * Set the avatar state, updating the image, CSS classes, and status text.
 * @param {string} state - One of STATES values
 * @param {string} [customStatusText] - Optional override for status text
 */
export function setState(state, customStatusText) {
  if (!Object.values(STATES).includes(state)) {
    console.warn(`Invalid avatar state: ${state}`);
    return;
  }

  currentState = state;

  const container = document.getElementById('avatar-container');
  const img = document.getElementById('avatar-img');
  const statusText = document.getElementById('status-text');
  const soundWave = document.getElementById('sound-wave');
  const stateLabel = document.getElementById('state-label');

  if (!container || !img || !statusText) {
    console.warn('Avatar DOM elements not found');
    return;
  }

  // Remove all state classes
  Object.values(STATES).forEach(s => container.classList.remove(s));
  // Add new state class
  container.classList.add(state);

  // Swap image
  img.src = IMAGES[state];
  img.alt = `Uni mascot - ${state}`;

  // Update status text
  statusText.textContent = customStatusText || STATUS_TEXTS[state];

  if (stateLabel) stateLabel.textContent = STATE_LABELS[state];

  // Toggle sound wave visibility
  if (soundWave) {
    if (state === STATES.LISTENING) {
      soundWave.classList.add('active');
    } else {
      soundWave.classList.remove('active');
    }
  }
}

/**
 * Get the current avatar state.
 * @returns {string} Current state
 */
export function getState() {
  return currentState;
}

/**
 * Preload all avatar images to avoid flicker on first state change.
 * @returns {Promise<void>}
 */
export function preloadImages() {
  const promises = Object.values(IMAGES).map(src => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = resolve;
      img.onerror = resolve; // Don't block on missing images
      img.src = src;
    });
  });
  return Promise.all(promises);
}
