/*
 * Settings storage for Uni's voice assistant.
 *
 * This module intentionally has no UI, network, or framework dependency. It
 * owns the browser-persisted prompt/voice values so the application controller
 * and Live audio engine do not need to duplicate validation rules.
 */

export const STORAGE_KEY = 'uni_voice_assistant_settings_v1';
export const SETTINGS_VERSION = 1;
export const MAX_PROMPT_LENGTH = 4000;

const DEFAULT_VOICE_ID = 'Kore';

function freezeRecords(records) {
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}

/**
 * Product-level voice IDs supported by the first settings UI.
 *
 * These are a reliability allowlist, not a security boundary. The available
 * voices should be rechecked against the active Gemini Live model before
 * release because preview API capabilities can change.
 */
export const VOICES = freezeRecords([
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
]);

/**
 * Prompt templates are plain data. The UI will render them with textContent
 * in a later phase, so prompt text is never treated as HTML.
 */
export const PROMPT_TEMPLATES = freezeRecords([
  {
    id: 'uni',
    title: 'Uni default',
    tagline: 'Friendly and encouraging companion',
    prompt: [
      'Bạn là Uni, linh vật Live United và là một người bạn trợ lý thân thiện.',
      'Hãy nói chuyện tự nhiên, tích cực và luôn khuyến khích người dùng.',
      'Luôn trả lời bằng tiếng Việt, trừ khi người dùng yêu cầu rõ ràng ngôn ngữ khác.',
    ].join('\n'),
  },
  {
    id: 'artist',
    title: 'Creative artist',
    tagline: 'Creative ideas and visual thinking',
    prompt: [
      'Bạn là một nghệ sĩ sáng tạo và cố vấn ý tưởng thị giác.',
      'Hãy giúp người dùng phát triển ý tưởng hội họa, thiết kế, màu sắc và bố cục.',
      'Trả lời bằng tiếng Việt, giàu hình ảnh nhưng ngắn gọn, dễ nghe khi nói thành tiếng.',
    ].join('\n'),
  },
  {
    id: 'math',
    title: 'Math and logic tutor',
    tagline: 'Patient, clear, step-by-step guidance',
    prompt: [
      'Bạn là một gia sư toán học và tư duy logic kiên nhẫn.',
      'Hãy giải thích rõ ràng, ưu tiên từng bước dễ hiểu và khuyến khích người học tự suy nghĩ.',
      'Trả lời bằng tiếng Việt, chính xác và ngắn gọn để phù hợp với hội thoại bằng giọng nói.',
    ].join('\n'),
  },
  {
    id: 'coach',
    title: 'Language conversation coach',
    tagline: 'Friendly speaking practice partner',
    prompt: [
      'Bạn là một huấn luyện viên luyện nói tiếng Anh và tiếng Việt thân thiện.',
      'Hãy khuyến khích người dùng giao tiếp tự tin và sửa cách diễn đạt khi cần.',
      'Giải thích ngắn gọn bằng tiếng Việt, chỉ dùng tiếng Anh khi người dùng đang luyện tập.',
    ].join('\n'),
  },
]);

const DEFAULT_PROMPT = PROMPT_TEMPLATES[0].prompt;

/**
 * Default settings are immutable. Public functions always return fresh
 * objects so callers cannot accidentally change the module defaults.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  voiceId: DEFAULT_VOICE_ID,
  prompt: DEFAULT_PROMPT,
});

function createDefaultSettings() {
  return {
    voiceId: DEFAULT_SETTINGS.voiceId,
    prompt: DEFAULT_SETTINGS.prompt,
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

/**
 * Normalize a settings object without mutating it.
 *
 * Invalid/missing voice IDs and prompts fall back to defaults. An oversized
 * prompt throws RangeError instead of being silently truncated. Callers that
 * read persisted data should catch this and use defaults; callers saving user
 * input can show the error and keep the editor open.
 *
 * @param {unknown} settings
 * @returns {{voiceId: string, prompt: string}}
 * @throws {RangeError} When prompt exceeds MAX_PROMPT_LENGTH.
 */
export function normalizeSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const voiceId = isKnownVoiceId(source.voiceId)
    ? source.voiceId
    : DEFAULT_SETTINGS.voiceId;

  let prompt = DEFAULT_SETTINGS.prompt;
  if (typeof source.prompt === 'string' && source.prompt.trim().length > 0) {
    prompt = source.prompt.trim();
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new RangeError(
      `The chatbot prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
    );
  }

  return { voiceId, prompt };
}

/**
 * Read settings from localStorage. Storage errors, invalid JSON, and invalid
 * persisted values recover to defaults without logging the user's prompt.
 *
 * @returns {{voiceId: string, prompt: string}}
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
 * Oversized prompts throw RangeError. Storage write failures throw a generic
 * error without including the prompt, allowing the UI to report the failure
 * without leaking user content into logs.
 *
 * @param {unknown} settings
 * @returns {{voiceId: string, prompt: string}}
 */
export function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  const storage = getStorage();

  if (!storage) {
    throw new Error('Settings storage is unavailable in this browser.');
  }

  const storedValue = {
    version: SETTINGS_VERSION,
    ...normalized,
    updatedAt: Date.now(),
  };

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(storedValue));
  } catch (_) {
    throw new Error('Unable to save Uni settings in this browser.');
  }

  return { ...normalized };
}

/**
 * Remove persisted settings and return fresh defaults.
 *
 * A storage removal failure does not make the application unusable; the
 * returned defaults can still be used for the current page session.
 *
 * @returns {{voiceId: string, prompt: string}}
 */
export function resetSettings() {
  const storage = getStorage();

  if (storage) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (_) {
      console.warn('Unable to clear saved Uni settings.');
    }
  }

  return createDefaultSettings();
}

/**
 * Find a voice by ID without exposing the frozen internal record.
 *
 * @param {unknown} voiceId
 * @returns {{id: string, label: string, description: string}|null}
 */
export function getVoiceById(voiceId) {
  const voice = VOICES.find((candidate) => candidate.id === voiceId);
  return voice ? { ...voice } : null;
}
