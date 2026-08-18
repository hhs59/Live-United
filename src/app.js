/* ============================================================
   App.js — Main voice-only application logic
   ============================================================ */

import { createLiveSession, isLiveAudioSupported } from './modules/live.js';
import { setState, getState, preloadImages, STATES } from './modules/avatar.js';
import {
  DEFAULT_SETTINGS,
  MAX_PROMPT_LENGTH,
  PROMPT_TEMPLATES,
  VOICES,
  getSettings,
  getVoiceById,
  normalizeSettings,
  saveSettings,
} from './modules/settings.js';

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const unsupportedBanner = document.getElementById('unsupported-banner');
const settingsBtn = document.getElementById('settings-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsForm = document.getElementById('settings-form');
const settingsClose = document.getElementById('settings-close');
const settingsPrompt = document.getElementById('settings-prompt');
const promptTemplates = document.getElementById('prompt-templates');
const promptCount = document.getElementById('prompt-count');
const promptError = document.getElementById('prompt-error');
const settingsVoice = document.getElementById('settings-voice');
const settingsReset = document.getElementById('settings-reset');
const settingsCancel = document.getElementById('settings-cancel');
const settingsSave = document.getElementById('settings-save');
const settingsNotice = document.getElementById('settings-notice');
const voiceBadgeLabel = document.getElementById('voice-badge-label');

let liveSession = null;
let isProcessing = false;
let shuttingDown = false;
let savedSettings = getSettings();
let settingsCloseTimer = null;

function setControls(mode) {
  const isIdle = mode === 'idle';

  startBtn.hidden = !isIdle;
  stopBtn.hidden = isIdle;
  if (!isIdle) stopBtn.disabled = false;
}

function updateVoiceBadge(settings) {
  if (!voiceBadgeLabel) return;

  const voice = getVoiceById(settings.voiceId);
  voiceBadgeLabel.textContent = `Voice · ${voice?.label || settings.voiceId}`;
}

function updatePromptCounter() {
  if (!settingsPrompt || !promptCount) return;
  promptCount.textContent = String(settingsPrompt.value.length);
}

function updateTemplateSelection() {
  if (!promptTemplates || !settingsPrompt) return;

  const currentPrompt = settingsPrompt.value.trim();
  for (const button of promptTemplates.querySelectorAll('button[data-template-id]')) {
    const template = PROMPT_TEMPLATES.find(
      (candidate) => candidate.id === button.dataset.templateId,
    );
    const selected = Boolean(template && template.prompt.trim() === currentPrompt);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function updatePromptValidation() {
  if (!settingsPrompt || !settingsSave) return;

  updatePromptCounter();
  const isTooLong = settingsPrompt.value.length > MAX_PROMPT_LENGTH;

  if (isTooLong) {
    settingsPrompt.setAttribute('aria-invalid', 'true');
    if (promptError) {
      promptError.textContent = `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`;
    }
  } else {
    settingsPrompt.removeAttribute('aria-invalid');
    if (promptError) promptError.textContent = '';
  }

  settingsSave.disabled = isTooLong;
  updateTemplateSelection();
}

function populateVoiceOptions() {
  if (!settingsVoice) return;

  settingsVoice.replaceChildren();
  for (const voice of VOICES) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.label;
    option.title = voice.description;
    settingsVoice.append(option);
  }
}

function renderPromptTemplates() {
  if (!promptTemplates) return;

  promptTemplates.replaceChildren();
  for (const template of PROMPT_TEMPLATES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.templateId = template.id;
    button.setAttribute('aria-pressed', 'false');
    button.title = template.tagline;

    const title = document.createElement('span');
    title.className = 'prompt-template-title';
    title.textContent = template.title;

    const tagline = document.createElement('span');
    tagline.className = 'prompt-template-tagline';
    tagline.textContent = template.tagline;

    button.append(title, tagline);
    promptTemplates.append(button);
  }
}

function populateSettingsForm(settings) {
  if (!settingsPrompt || !settingsVoice) return;

  settingsPrompt.value = settings.prompt;
  settingsVoice.value = settings.voiceId;
  updatePromptValidation();
}

function clearSettingsMessages() {
  if (promptError) promptError.textContent = '';
  if (settingsNotice) settingsNotice.textContent = '';
}

function openSettings() {
  if (!settingsDialog || settingsDialog.open) return;

  savedSettings = getSettings();
  populateSettingsForm(savedSettings);
  clearSettingsMessages();

  if (typeof settingsDialog.showModal === 'function') {
    settingsDialog.showModal();
  } else {
    settingsDialog.setAttribute('open', '');
  }

  settingsPrompt?.focus();
}

function closeSettings() {
  if (settingsCloseTimer) {
    window.clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
  }

  if (!settingsDialog) return;
  if (typeof settingsDialog.close === 'function' && settingsDialog.open) {
    settingsDialog.close();
  } else {
    settingsDialog.removeAttribute('open');
  }
}

function isSessionActive() {
  return Boolean(
    isProcessing ||
    liveSession?.isConnected?.() ||
    liveSession?.isListening?.() ||
    !stopBtn.hidden,
  );
}

function saveDraftSettings() {
  if (!settingsPrompt || !settingsVoice) return;

  try {
    const normalized = normalizeSettings({
      prompt: settingsPrompt.value,
      voiceId: settingsVoice.value,
    });
    savedSettings = saveSettings(normalized);
    updateVoiceBadge(savedSettings);

    if (settingsNotice) {
      settingsNotice.textContent = isSessionActive()
        ? 'Settings saved. They will apply when you start the next session.'
        : 'Settings saved.';
    }

    settingsCloseTimer = window.setTimeout(closeSettings, 700);
  } catch (error) {
    if (error instanceof RangeError) {
      settingsPrompt.setAttribute('aria-invalid', 'true');
      if (promptError) promptError.textContent = error.message;
      settingsSave.disabled = true;
      return;
    }

    if (settingsNotice) {
      settingsNotice.textContent = error.message || 'Unable to save settings.';
    }
  }
}

function initializeSettings() {
  populateVoiceOptions();
  renderPromptTemplates();
  updateVoiceBadge(savedSettings);
}

settingsBtn?.addEventListener('click', openSettings);
settingsClose?.addEventListener('click', closeSettings);
settingsCancel?.addEventListener('click', closeSettings);

settingsDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeSettings();
});

settingsDialog?.addEventListener('click', (event) => {
  if (event.target === settingsDialog) closeSettings();
});

settingsForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!settingsSave?.disabled) saveDraftSettings();
});

settingsPrompt?.addEventListener('input', () => {
  updatePromptValidation();
});

settingsReset?.addEventListener('click', () => {
  populateSettingsForm(DEFAULT_SETTINGS);
  if (settingsNotice) settingsNotice.textContent = 'Defaults ready to save.';
});

promptTemplates?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-template-id]');
  if (!button || !promptTemplates.contains(button)) return;

  const template = PROMPT_TEMPLATES.find(
    (candidate) => candidate.id === button.dataset.templateId,
  );
  if (!template || !settingsPrompt) return;

  settingsPrompt.value = template.prompt;
  updatePromptValidation();
});

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

  savedSettings = getSettings();
  updateVoiceBadge(savedSettings);

  isProcessing = true;
  startBtn.disabled = true;
  setControls('busy');
  setState(STATES.THINKING, 'Connecting to Uni...');

  try {
    await liveSession.startListening({
      systemPrompt: savedSettings.prompt,
      voiceName: savedSettings.voiceId,
    });
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
  if (
    settingsDialog?.open ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName)
  ) return;

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
  initializeSettings();

  if (!isLiveAudioSupported()) {
    unsupportedBanner.textContent =
      'Real-time audio is not supported in this browser. Use the latest Chrome or Edge.';
    unsupportedBanner.classList.add('show');
    startBtn.disabled = true;
    setControls('idle');
    return;
  }

  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    unsupportedBanner.textContent =
      'Mobile browsers usually require HTTPS for microphone access. Use HTTPS or localhost.';
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
