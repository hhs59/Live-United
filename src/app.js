/* ============================================================
   App.js — Main voice-only application logic
   ============================================================ */

import { createLiveSession, isLiveAudioSupported } from './modules/live.js';
import { setState, getState, preloadImages, STATES } from './modules/avatar.js';

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const unsupportedBanner = document.getElementById('unsupported-banner');

let liveSession = null;
let isProcessing = false;
let shuttingDown = false;

function setControls(mode) {
  const isIdle = mode === 'idle';
  const isListening = mode === 'listening';

  startBtn.hidden = !isIdle;
  stopBtn.hidden = !isListening;
  if (isListening) stopBtn.disabled = false;
}

function showError(message) {
  isProcessing = false;
  startBtn.disabled = false;
  startBtn.classList.remove('active');
  setControls('idle');
  setState(STATES.ERROR, message || 'Unable to connect to Uni.');

  setTimeout(() => {
    if (!shuttingDown && getState() === STATES.ERROR) {
      setState(STATES.IDLE);
    }
  }, 4000);
}

function createSession() {
  liveSession = createLiveSession({
    onConnecting: () => {
      setState(STATES.THINKING, 'Connecting to Uni...');
    },

    onConnected: () => {
      setControls('listening');
    },

    onListening: () => {
      startBtn.disabled = false;
      startBtn.classList.add('active');
      setControls('listening');
      setState(STATES.LISTENING);
    },

    onThinking: () => {
      startBtn.classList.remove('active');
      setControls('busy');
      setState(STATES.THINKING, 'Uni is thinking...');
    },

    onAudioStart: () => {
      setControls('busy');
      setState(STATES.SPEAKING, 'Speaking...');
    },

    onTurnComplete: () => {
      if (liveSession?.isListening()) return;
      isProcessing = false;
      startBtn.disabled = false;
      startBtn.classList.remove('active');
      setControls('idle');
      setState(STATES.IDLE);
    },

    onInterrupted: () => {
      if (liveSession?.isListening()) {
        startBtn.classList.add('active');
        setControls('listening');
        setState(STATES.LISTENING);
      } else {
        startBtn.classList.remove('active');
        setControls('idle');
        setState(STATES.IDLE);
      }
    },

    onPlaybackInterrupted: () => {
      if (!liveSession?.isListening() && getState() === STATES.SPEAKING) {
        setState(STATES.IDLE);
      }
    },

    onStopped: () => {
      isProcessing = false;
      startBtn.disabled = false;
      startBtn.classList.remove('active');
      setControls('idle');
      setState(STATES.IDLE);
    },

    onError: (message) => {
      showError(message);
    },

    onDisconnected: () => {
      if (!shuttingDown && getState() !== STATES.IDLE) {
        showError('The Gemini Live session disconnected. Please try again.');
      }
    },
  });
}

async function beginListening() {
  if (!liveSession || isProcessing) return;

  isProcessing = true;
  startBtn.disabled = true;
  setControls('busy');
  setState(STATES.THINKING, 'Connecting to Uni...');

  try {
    await liveSession.startListening();
  } catch (error) {
    console.error('Failed to start Gemini Live:', error);

    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      showError('Microphone permission was denied. Check your browser settings.');
    } else if (error.name === 'NotFoundError') {
      showError('No microphone was found. Check your audio device.');
    } else {
      showError(error.message || 'Unable to start the voice session.');
    }
  }
}

startBtn.addEventListener('click', beginListening);

stopBtn.addEventListener('click', () => {
  if (!liveSession) return;
  stopBtn.disabled = true;
  liveSession.stop();
});

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

  if (event.code === 'Space') {
    event.preventDefault();
    if (!stopBtn.hidden && !stopBtn.disabled) {
      stopBtn.click();
    } else {
      startBtn.click();
    }
  }
});

async function init() {
  if (!isLiveAudioSupported()) {
    unsupportedBanner.textContent =
      '⚠️ Real-time audio is not supported in this browser. Use the latest Chrome or Edge.';
    unsupportedBanner.classList.add('show');
    startBtn.disabled = true;
    setControls('idle');
    return;
  }

  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    unsupportedBanner.textContent =
      '⚠️ Mobile browsers usually require HTTPS for microphone access. Use HTTPS or localhost.';
    unsupportedBanner.classList.add('show');
  }

  createSession();
  await preloadImages();
  setState(STATES.IDLE);
}

window.addEventListener('pagehide', () => {
  shuttingDown = true;
  liveSession?.destroy();
});

init();
