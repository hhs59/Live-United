/* ============================================================
   App.js — Main voice-only application logic
   ============================================================ */

import { createLiveSession, isLiveAudioSupported } from './modules/live.js?v=17';
import { createLayeredAvatarRenderer } from './modules/avatar_game_renderer.js?v=15';
import {
  DEFAULT_SETTINGS,
  MAX_CUSTOM_PROMPTS,
  UNI_PROMPT,
  VOICES,
  getSettings,
  normalizeSettings,
  saveSettings,
} from './modules/settings.js';

const STATES = {
  IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking', ERROR: 'error',
};
const STATUS_TEXTS = {
  idle: '', listening: '', thinking: 'Uni is thinking...', speaking: 'Speaking...', error: 'Something went wrong.',
};

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const unsupportedBanner = document.getElementById('unsupported-banner');
const settingsBtn = document.getElementById('settings-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsForm = document.getElementById('settings-form');
const settingsClose = document.getElementById('settings-close');
const settingsPrompt = document.getElementById('settings-prompt');
const settingsPromptName = document.getElementById('settings-prompt-name');
const promptList = document.getElementById('prompt-list');
const promptAdd = document.getElementById('prompt-add');
const promptEdit = document.getElementById('prompt-edit');
const promptEditor = document.getElementById('prompt-editor');
const promptDelete = document.getElementById('prompt-delete');
const promptEditorCancel = document.getElementById('prompt-editor-cancel');
const promptEditorSave = document.getElementById('prompt-editor-save');
const promptCount = document.getElementById('prompt-count');
const promptError = document.getElementById('prompt-error');
const settingsVoice = document.getElementById('settings-voice');
const settingsReset = document.getElementById('settings-reset');
const settingsCancel = document.getElementById('settings-cancel');
const settingsSave = document.getElementById('settings-save');
const settingsNotice = document.getElementById('settings-notice');
const voiceBadgeLabel = document.getElementById('voice-badge-label');
const avatarContainer = document.getElementById('avatar-container');
const avatarCanvas = document.getElementById('avatar-game-canvas');
const statusText = document.getElementById('status-text');
const soundWave = document.getElementById('sound-wave');
const stateLabel = document.getElementById('state-label');

let liveSession = null;
let avatarRenderer = null;
let isProcessing = false;
let shuttingDown = false;
let savedSettings = getSettings();
let draftSettings = null;
let editingPromptId = null;
let settingsCloseTimer = null;
let pendingAvatarGesture = null;
let currentState = STATES.IDLE;

function setState(state, message) {
  currentState = state;
  avatarContainer.classList.remove(...Object.values(STATES));
  avatarContainer.classList.add(state);
  statusText.textContent = message || STATUS_TEXTS[state];
  stateLabel.textContent = state === 'idle' ? 'READY' : state.toUpperCase();
  soundWave.classList.toggle('active', state === STATES.LISTENING);
}

function getState() {
  return currentState;
}

function setUiState(state, message) {
  setState(state, message);
  avatarRenderer?.setState(state);
}

function setControls(mode) {
  const isIdle = mode === 'idle';

  startBtn.hidden = !isIdle;
  stopBtn.hidden = isIdle;
  if (!isIdle) stopBtn.disabled = false;
}

function updateVoiceBadge(settings) {
  const voice = VOICES.find((candidate) => candidate.id === settings.voiceId);
  voiceBadgeLabel.textContent = `Voice · ${voice?.label || settings.voiceId}`;
}

function cloneSettings(settings) {
  return structuredClone(settings);
}

function getDraftPrompt(promptId) {
  if (promptId === UNI_PROMPT.id) return UNI_PROMPT;
  return draftSettings?.customPrompts.find((prompt) => prompt.id === promptId) || null;
}

function createPromptId() {
  if (globalThis.crypto?.randomUUID) return `custom-${globalThis.crypto.randomUUID()}`;
  return `custom-${Date.now().toString(36)}`;
}

function setSettingsNotice(message = '') {
  settingsNotice.textContent = message;
}

function renderPromptList() {
  if (!draftSettings) return;

  promptList.replaceChildren();
  const prompts = [UNI_PROMPT, ...draftSettings.customPrompts];
  for (const prompt of prompts) {
    const button = document.createElement('button');
    const selected = prompt.id === draftSettings.activePromptId;
    button.type = 'button';
    button.dataset.promptId = prompt.id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(selected));

    const name = document.createElement('span');
    name.className = 'prompt-option-name';
    name.textContent = prompt.name;

    const type = document.createElement('span');
    type.className = 'prompt-option-type';
    type.textContent = prompt.id === UNI_PROMPT.id ? 'Built-in default' : 'Custom prompt';

    button.append(name, type);
    promptList.append(button);
  }

  promptEdit.hidden = draftSettings.activePromptId === UNI_PROMPT.id;
  promptAdd.disabled = draftSettings.customPrompts.length >= MAX_CUSTOM_PROMPTS;
  promptAdd.title = promptAdd.disabled ? `Maximum ${MAX_CUSTOM_PROMPTS} custom prompts` : '';
}

function closePromptEditor() {
  editingPromptId = null;
  promptEditor.hidden = true;
  settingsPromptName.disabled = true;
  settingsPrompt.disabled = true;
  settingsSave.disabled = false;
  promptError.textContent = '';
}

function updatePromptEditorValidation() {
  settingsPromptName.setCustomValidity(settingsPromptName.value.trim() ? '' : 'Enter a prompt name.');
  settingsPrompt.setCustomValidity(settingsPrompt.value.trim() ? '' : 'Enter prompt instructions.');
  const valid = settingsPromptName.checkValidity() && settingsPrompt.checkValidity();
  promptCount.textContent = String(settingsPrompt.value.length);
  settingsPromptName.toggleAttribute('aria-invalid', !settingsPromptName.checkValidity());
  settingsPrompt.toggleAttribute('aria-invalid', !settingsPrompt.checkValidity());
  promptError.textContent = valid
    ? ''
    : settingsPromptName.validationMessage || settingsPrompt.validationMessage;
  promptEditorSave.disabled = !valid;
}

function openPromptEditor(promptId = null) {
  if (!draftSettings) return;

  const prompt = promptId ? getDraftPrompt(promptId) : null;
  if (promptId && (!prompt || prompt.id === UNI_PROMPT.id)) return;

  editingPromptId = prompt?.id || null;
  settingsPromptName.disabled = false;
  settingsPrompt.disabled = false;
  settingsPromptName.value = prompt?.name || '';
  settingsPrompt.value = prompt?.prompt || '';
  promptEditor.hidden = false;
  promptDelete.hidden = !editingPromptId;
  promptEditorSave.textContent = editingPromptId ? 'Save prompt' : 'Add prompt';
  settingsSave.disabled = true;
  setSettingsNotice('');
  updatePromptEditorValidation();
  settingsPromptName.focus();
}

function savePromptEditor() {
  if (!draftSettings) return;
  updatePromptEditorValidation();
  if (promptEditorSave.disabled) return;

  const record = {
    id: editingPromptId || createPromptId(),
    name: settingsPromptName.value.trim(),
    prompt: settingsPrompt.value.trim(),
  };
  const existingIndex = draftSettings.customPrompts.findIndex(
    (prompt) => prompt.id === editingPromptId,
  );

  if (existingIndex >= 0) draftSettings.customPrompts[existingIndex] = record;
  else if (draftSettings.customPrompts.length < MAX_CUSTOM_PROMPTS) {
    draftSettings.customPrompts.push(record);
  } else return;

  draftSettings.activePromptId = record.id;
  draftSettings.prompt = record.prompt;
  closePromptEditor();
  renderPromptList();
  setSettingsNotice('Prompt ready. Save settings to keep changes.');
}

function deleteEditedPrompt() {
  if (!draftSettings || !editingPromptId) return;
  draftSettings.customPrompts = draftSettings.customPrompts.filter(
    (prompt) => prompt.id !== editingPromptId,
  );
  if (draftSettings.activePromptId === editingPromptId) {
    draftSettings.activePromptId = UNI_PROMPT.id;
    draftSettings.prompt = UNI_PROMPT.prompt;
  }
  closePromptEditor();
  renderPromptList();
  setSettingsNotice('Prompt removed. Save settings to keep changes.');
}

function populateVoiceOptions() {
  settingsVoice.replaceChildren();
  for (const voice of VOICES) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.label;
    option.title = voice.description;
    settingsVoice.append(option);
  }
}

function populateSettingsForm(settings) {
  draftSettings = cloneSettings(settings);
  settingsVoice.value = settings.voiceId;
  closePromptEditor();
  renderPromptList();
}

function clearSettingsMessages() {
  promptError.textContent = '';
  settingsNotice.textContent = '';
}

function openSettings() {
  if (settingsDialog.open) return;

  savedSettings = getSettings();
  populateSettingsForm(savedSettings);
  clearSettingsMessages();

  settingsDialog.showModal();

  promptList?.querySelector('[aria-selected="true"]')?.focus();
}

function closeSettings() {
  if (settingsCloseTimer) {
    window.clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
  }

  if (settingsDialog.open) settingsDialog.close();
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
  if (!draftSettings) return;

  try {
    const normalized = normalizeSettings({
      voiceId: settingsVoice.value,
      activePromptId: draftSettings.activePromptId,
      customPrompts: draftSettings.customPrompts,
    });
    savedSettings = saveSettings(normalized);
    updateVoiceBadge(savedSettings);

    settingsNotice.textContent = isSessionActive()
      ? 'Settings saved. They will apply when you start the next session.'
      : 'Settings saved.';

    settingsCloseTimer = window.setTimeout(closeSettings, 700);
  } catch (error) {
    setSettingsNotice(error.message || 'Unable to save settings.');
  }
}

function initializeSettings() {
  populateVoiceOptions();
  updateVoiceBadge(savedSettings);
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsCancel.addEventListener('click', closeSettings);

settingsDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeSettings();
});

settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) closeSettings();
});

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!settingsSave.disabled) saveDraftSettings();
});

settingsPrompt.addEventListener('input', updatePromptEditorValidation);
settingsPromptName.addEventListener('input', updatePromptEditorValidation);

settingsReset.addEventListener('click', () => {
  if (!draftSettings) return;
  draftSettings.activePromptId = UNI_PROMPT.id;
  draftSettings.prompt = UNI_PROMPT.prompt;
  settingsVoice.value = DEFAULT_SETTINGS.voiceId;
  closePromptEditor();
  renderPromptList();
  setSettingsNotice('Default prompt and voice ready to save.');
});

promptList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-prompt-id]');
  if (!button || !promptList.contains(button) || !draftSettings) return;
  const prompt = getDraftPrompt(button.dataset.promptId);
  if (!prompt) return;

  draftSettings.activePromptId = prompt.id;
  draftSettings.prompt = prompt.prompt;
  closePromptEditor();
  renderPromptList();
});

promptAdd.addEventListener('click', () => openPromptEditor());
promptEdit.addEventListener('click', () => openPromptEditor(draftSettings?.activePromptId));
promptEditorCancel.addEventListener('click', closePromptEditor);
promptEditorSave.addEventListener('click', savePromptEditor);
promptDelete.addEventListener('click', deleteEditedPrompt);

function showError(message) {
  isProcessing = false;
  pendingAvatarGesture = null;
  startBtn.disabled = false;
  startBtn.classList.remove('active');
  setControls('idle');
  avatarRenderer?.setAudioLevel(0);
  avatarRenderer?.stop();
  setUiState(STATES.ERROR, message || 'Unable to connect to Uni.');

  setTimeout(() => {
    if (!shuttingDown && getState() === STATES.ERROR) {
      setUiState(STATES.IDLE);
    }
  }, 4000);
}

function createSession() {
  liveSession = createLiveSession({
    onConnecting: () => {
      setUiState(STATES.THINKING, 'Connecting to Uni...');
    },

    onConnected: () => {
      setControls('listening');
    },

    onListening: () => {
      startBtn.disabled = false;
      startBtn.classList.add('active');
      setControls('listening');
      setUiState(STATES.LISTENING);
    },

    onAudioStart: () => {
      avatarRenderer?.setAudioLevel(0);
      setControls('busy');
      setUiState(STATES.SPEAKING, 'Speaking...');
      if (pendingAvatarGesture) {
        avatarRenderer?.playGesture(pendingAvatarGesture);
        pendingAvatarGesture = null;
      }
    },

    onAudioLevel: (level) => {
      avatarRenderer?.setAudioLevel(level);
    },

    onAvatarGesture: (name) => {
      if (name === 'neutral') {
        pendingAvatarGesture = null;
        avatarRenderer?.playGesture(name);
      } else if (getState() === STATES.SPEAKING) {
        avatarRenderer?.playGesture(name);
      } else {
        pendingAvatarGesture = name;
      }
    },

    onTurnComplete: () => {
      pendingAvatarGesture = null;
      avatarRenderer?.setAudioLevel(0);
      if (liveSession?.isListening()) return;
      isProcessing = false;
      startBtn.disabled = false;
      startBtn.classList.remove('active');
      setControls('idle');
      setUiState(STATES.IDLE);
    },

    onInterrupted: () => {
      pendingAvatarGesture = null;
      avatarRenderer?.setAudioLevel(0);
      if (liveSession?.isListening()) {
        startBtn.classList.add('active');
        setControls('listening');
        setUiState(STATES.LISTENING);
      } else {
        startBtn.classList.remove('active');
        setControls('idle');
        setUiState(STATES.IDLE);
      }
    },

    onPlaybackInterrupted: () => {
      avatarRenderer?.setAudioLevel(0);
      if (!liveSession?.isListening() && getState() === STATES.SPEAKING) {
        setUiState(STATES.IDLE);
      }
    },

    onStopped: () => {
      pendingAvatarGesture = null;
      isProcessing = false;
      startBtn.disabled = false;
      startBtn.classList.remove('active');
      setControls('idle');
      avatarRenderer?.setAudioLevel(0);
      avatarRenderer?.stop();
      setUiState(STATES.IDLE);
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
  setUiState(STATES.THINKING, 'Connecting to Uni...');

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
    settingsDialog.open ||
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
  avatarRenderer = createLayeredAvatarRenderer({
    canvas: avatarCanvas,
    container: avatarContainer,
    onError: (error) => {
      console.warn('Avatar renderer failed; voice remains available.', error);
    },
  });
  avatarRenderer.show();
  avatarRenderer.connect();

  if (!isLiveAudioSupported()) {
    unsupportedBanner.textContent =
      'Real-time audio is not supported in this browser. Use the latest Chrome or Edge.';
    unsupportedBanner.classList.add('show');
    startBtn.disabled = true;
    setControls('idle');
    setUiState(STATES.IDLE);
    return;
  }

  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    unsupportedBanner.textContent =
      'Mobile browsers usually require HTTPS for microphone access. Use HTTPS or localhost.';
    unsupportedBanner.classList.add('show');
  }

  createSession();
  setUiState(STATES.IDLE);
}

window.addEventListener('pagehide', () => {
  shuttingDown = true;
  liveSession?.destroy();
  avatarRenderer?.destroy();
});

init();
