/*
 * Settings storage for Uni's voice assistant.
 *
 * This module intentionally has no UI, network, or framework dependency. It
 * owns the browser-persisted prompt/voice values so the application controller
 * and Live audio engine do not need to duplicate validation rules.
 */

export const STORAGE_KEY = 'uni_voice_assistant_settings_v1';
export const MAX_PROMPT_LENGTH = 4000;
export const MAX_PROMPT_NAME_LENGTH = 50;
export const MAX_CUSTOM_PROMPTS = 10;

const DEFAULT_VOICE_ID = 'Kore';

/**
 * Product-level voice IDs supported by the first settings UI.
 *
 * These are a reliability allowlist, not a security boundary. The available
 * voices should be rechecked against the active Gemini Live model before
 * release because preview API capabilities can change.
 */
export const VOICES = [
  {
    id: 'Kore',
    label: 'Kore',
    description: 'Warm and balanced',
  },
  {
    id: 'Puck',
    label: 'Puck',
    description: 'Playful and energetic',
  },
  {
    id: 'Charon',
    label: 'Charon',
    description: 'Calm and resonant',
  },
  {
    id: 'Fenrir',
    label: 'Fenrir',
    description: 'Clear and confident',
  },
  {
    id: 'Aoede',
    label: 'Aoede',
    description: 'Soft and melodic',
  },
];

export const UNI_PROMPT = {
  id: 'uni',
  name: 'UNI',
  prompt: [
    'Bạn là Uni, linh vật Live United và là một người bạn trợ lý thân thiện.',
    'Hãy nói chuyện tự nhiên, tích cực và luôn khuyến khích người dùng.',
    'Luôn trả lời bằng tiếng Việt, trừ khi người dùng yêu cầu rõ ràng ngôn ngữ khác.',
  ].join('\n'),
};

export const DEFAULT_SETTINGS = {
  voiceId: DEFAULT_VOICE_ID,
  activePromptId: UNI_PROMPT.id,
  prompt: UNI_PROMPT.prompt,
  customPrompts: [],
};

function createDefaultSettings() {
  return {
    voiceId: DEFAULT_SETTINGS.voiceId,
    activePromptId: DEFAULT_SETTINGS.activePromptId,
    prompt: DEFAULT_SETTINGS.prompt,
    customPrompts: [],
  };
}

function getStorage() {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage || null;
  } catch (_) {
    // Browsers can expose localStorage but deny access in private/restricted
    // contexts. Treat it as unavailable and keep the app usable in memory.
    return null;
  }
}

function isKnownVoiceId(voiceId) {
  return VOICES.some((voice) => voice.id === voiceId);
}

function normalizeCustomPrompts(value) {
  if (!Array.isArray(value)) return [];

  const prompts = [];
  const ids = new Set([UNI_PROMPT.id]);
  for (const candidate of value) {
    if (prompts.length >= MAX_CUSTOM_PROMPTS) break;
    if (!candidate || typeof candidate !== 'object') continue;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';
    if (
      !id || ids.has(id) ||
      !name || name.length > MAX_PROMPT_NAME_LENGTH ||
      !prompt || prompt.length > MAX_PROMPT_LENGTH
    ) continue;

    ids.add(id);
    prompts.push({ id, name, prompt });
  }
  return prompts;
}

/**
 * Normalize a settings object without mutating it.
 *
 * Invalid voice IDs and selections fall back to defaults. Invalid persisted
 * custom prompt records are ignored so one damaged record does not prevent
 * the rest of the settings from loading.
 *
 * @param {unknown} settings
 * @returns {{voiceId: string, activePromptId: string, prompt: string, customPrompts: Array}}
 */
export function normalizeSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const voiceId = isKnownVoiceId(source.voiceId)
    ? source.voiceId
    : DEFAULT_SETTINGS.voiceId;

  const customPrompts = normalizeCustomPrompts(source.customPrompts);
  let activePromptId = source.activePromptId === UNI_PROMPT.id
    ? UNI_PROMPT.id
    : customPrompts.some((prompt) => prompt.id === source.activePromptId)
      ? source.activePromptId
      : UNI_PROMPT.id;

  // Preserve the previous single-prompt storage format during migration.
  if (typeof source.activePromptId !== 'string') {
    const legacyPrompt = typeof source.prompt === 'string' ? source.prompt.trim() : '';
    if (legacyPrompt && legacyPrompt !== UNI_PROMPT.prompt && legacyPrompt.length <= MAX_PROMPT_LENGTH) {
      const existing = customPrompts.find((prompt) => prompt.prompt === legacyPrompt);
      if (existing) {
        activePromptId = existing.id;
      } else if (customPrompts.length < MAX_CUSTOM_PROMPTS) {
        const migrated = { id: 'custom-migrated', name: 'Saved prompt', prompt: legacyPrompt };
        customPrompts.push(migrated);
        activePromptId = migrated.id;
      }
    }
  }

  const activePrompt = activePromptId === UNI_PROMPT.id
    ? UNI_PROMPT
    : customPrompts.find((prompt) => prompt.id === activePromptId) || UNI_PROMPT;

  return {
    voiceId,
    activePromptId: activePrompt.id,
    prompt: activePrompt.prompt,
    customPrompts: customPrompts.map((prompt) => ({ ...prompt })),
  };
}

/**
 * Read settings from localStorage. Storage errors, invalid JSON, and invalid
 * persisted values recover to defaults without logging the user's prompt.
 *
 * @returns {{voiceId: string, activePromptId: string, prompt: string, customPrompts: Array}}
 */
export function getSettings() {
  const storage = getStorage();
  if (!storage) return createDefaultSettings();

  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (_) {
    console.warn('Unable to read saved Uni settings; using defaults.');
    return createDefaultSettings();
  }

  if (!raw) return createDefaultSettings();

  try {
    return normalizeSettings(JSON.parse(raw));
  } catch (_) {
    console.warn('Saved Uni settings are invalid; using defaults.');
    return createDefaultSettings();
  }
}

/**
 * Save normalized settings to localStorage.
 *
 * Storage write failures throw a generic error without including prompt text,
 * allowing the UI to report the failure without leaking user content to logs.
 *
 * @param {unknown} settings
 * @returns {{voiceId: string, activePromptId: string, prompt: string, customPrompts: Array}}
 */
export function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  const storage = getStorage();

  if (!storage) {
    throw new Error('Settings storage is unavailable in this browser.');
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      voiceId: normalized.voiceId,
      activePromptId: normalized.activePromptId,
      customPrompts: normalized.customPrompts,
    }));
  } catch (_) {
    throw new Error('Unable to save Uni settings in this browser.');
  }

  return normalized;
}

export function getVoiceById(voiceId) {
  return VOICES.find((voice) => voice.id === voiceId) || null;
}
