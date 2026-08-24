import {
  DEFAULT_SETTINGS,
  MAX_PROMPT_LENGTH,
  VOICES,
} from './settings.js';

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.' +
  'BidiGenerateContentConstrained';
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const DEFAULT_VOICE = DEFAULT_SETTINGS.voiceId;
const ALLOWED_VOICE_IDS = new Set(VOICES.map((voice) => voice.id));
const AUDIO_WORKLET_NAME = 'uni-pcm-capture';
const AVATAR_ANIMATION_TOOL = 'play_mascot_animation';
const AVATAR_ANIMATIONS = new Set(['wave', 'celebrate', 'emphasize', 'neutral']);

// The browser microphone context is commonly 44.1kHz or 48kHz. This worklet resamples it to the 16kHz, signed 16-bit PCM required by Live API.
const WORKLET_SOURCE = [
  'class UniPcmCaptureProcessor extends AudioWorkletProcessor {',
  '  constructor() {',
  '    super();',
  '    this.step = sampleRate / 16000;',
  '    this.inputBuffer = [];',
  '    this.position = 0;',
  '    this.outputBuffer = [];',
  '  }',
  '',
  '  process(inputs) {',
  '    const channel = inputs[0] && inputs[0][0];',
  '    if (!channel) return true;',
  '',
  '    for (let i = 0; i < channel.length; i += 1) {',
  '      this.inputBuffer.push(channel[i]);',
  '    }',
  '',
  '    const resampled = [];',
  '    while (this.position + 1 < this.inputBuffer.length) {',
  '      const index = Math.floor(this.position);',
  '      const fraction = this.position - index;',
  '      const first = this.inputBuffer[index];',
  '      const second = this.inputBuffer[index + 1];',
  '      resampled.push(first + (second - first) * fraction);',
  '      this.position += this.step;',
  '    }',
  '',
  '    const consumed = Math.floor(this.position);',
  '    if (consumed > 0) {',
  '      this.inputBuffer = this.inputBuffer.slice(consumed);',
  '      this.position -= consumed;',
  '    }',
  '',
  '    this.outputBuffer.push(...resampled);',
  '    while (this.outputBuffer.length >= 320) {',
  '      const pcm = new Int16Array(320);',
  '      for (let i = 0; i < pcm.length; i += 1) {',
  '        const sample = Math.max(-1, Math.min(1, this.outputBuffer[i]));',
  '        pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;',
  '      }',
  '      this.outputBuffer.splice(0, 320);',
  '      this.port.postMessage(pcm.buffer, [pcm.buffer]);',
  '    }',
  '',
  '    return true;',
  '  }',
  '}',
  '',
  'registerProcessor("uni-pcm-capture", UniPcmCaptureProcessor);',
].join('\n');

//check if the browser is supported or not
export function isLiveAudioSupported() {
  return Boolean(
    typeof window !== 'undefined' &&
    window.WebSocket &&
    window.AudioContext &&
    window.AudioWorkletNode &&
    navigator.mediaDevices?.getUserMedia
  );
}

//convert microphone PCM data into Base64
function encodeBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

//convert Gemini's respond into PCM 16
function decodePcm16(base64) {
  const binary = atob(base64);
  const pcm = new Int16Array(Math.floor(binary.length / 2));
  const view = new DataView(new ArrayBuffer(pcm.length * 2));

  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(
      i * 2,
      binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8),
      true
    );
  }

  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = view.getInt16(i * 2, true);
  }

  return pcm;
}

function getServerError(response) {
  if (response?.error?.message) return response.error.message;
  if (response?.error) return String(response.error);
  return 'The Gemini Live API closed the connection.';
}

// Normalize the prompt and voice before connecting to Gemini.
function normalizeSessionConfig(sessionConfig) {
  const source = sessionConfig && typeof sessionConfig === 'object'
    ? sessionConfig
    : {};
  const systemPrompt = typeof source.systemPrompt === 'string'
    ? source.systemPrompt.trim()
    : '';

  if (systemPrompt.length > MAX_PROMPT_LENGTH) {
    throw new RangeError(
      `The chatbot prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
    );
  }

  return {
    voiceName: ALLOWED_VOICE_IDS.has(source.voiceName)
      ? source.voiceName
      : DEFAULT_VOICE,
    systemPrompt,
  };
}

// Combine the custom prompt with the base prompt.
function composeSystemPrompt(basePrompt, customPrompt) {
  const base = typeof basePrompt === 'string' ? basePrompt.trim() : '';
  const custom = typeof customPrompt === 'string' ? customPrompt.trim() : '';

  if (!base) {
    throw new Error('The backend did not return the base system prompt.');
  }

  if (!custom) return base;

  return [
    base,
    'USER-CONFIGURED PERSONA AND TASK STYLE:',
    custom,
    'Continue to obey the base Vietnamese voice rules above.',
  ].join('\n\n');
}

/**
 * Normalize one playback RMS sample against the current response peak.
 *
 * This is intentionally pure: the caller owns the returned state, which makes
 * the audio-to-avatar mapping testable without Web Audio. The layered avatar
 * animator owns the visible mouth smoothing.
 */
export function normalizePlaybackLevel(rms, state = {}, options = {}) {
  const numericRms = Number(rms);
  const sample = Number.isFinite(numericRms) ? Math.max(0, numericRms) : 0;
  const noiseFloor = Number.isFinite(Number(options.noiseFloor))
    ? Math.max(0, Number(options.noiseFloor))
    : 0.005;
  const minimumPeak = Number.isFinite(Number(options.minimumPeak))
    ? Math.max(noiseFloor + 0.001, Number(options.minimumPeak))
    : 0.05;
  const peakRelease = Number.isFinite(Number(options.peakRelease))
    ? Math.min(1, Math.max(0.9, Number(options.peakRelease)))
    : 0.995;
  const previousPeak = Number.isFinite(Number(state.responsePeak))
    ? Math.max(0, Number(state.responsePeak))
    : 0;
  const responsePeak = Math.max(sample, previousPeak * peakRelease);
  const denominator = Math.max(minimumPeak, responsePeak) - noiseFloor;
  const level = denominator > 0
    ? Math.min(1, Math.max(0, (sample - noiseFloor) / denominator))
    : 0;

  return {
    level,
    state: { responsePeak },
  };
}

/**
 * Create one browser-side Gemini Live session.
 *
 * The permanent API key remains on the Python server. The browser receives
 * one short-lived token and connects directly to Gemini for lower latency.
 */
export function createLiveSession(callbacks = {}) {
  let websocket = null;
  let connectPromise = null;
  let setupReady = false;
  let isCapturing = false;
  let stopRequested = false;
  let operationId = 0;
  let tokenRequestController = null;

  let audioContext = null;
  let microphoneStream = null;
  let microphoneSource = null;
  let captureNode = null;
  let muteNode = null;
  let workletUrl = null;

  let playbackSources = new Set();
  let playbackAnalyser = null;
  let playbackAnalyserData = null;
  let playbackLevelFrame = null;
  let playbackLevelGeneration = 0;
  let playbackLevelState = { responsePeak: 0 };
  let playbackAnalyserWarningShown = false;
  let nextPlaybackTime = 0;
  let playbackGeneration = 0;
  let turnCompletePending = false;
  let responseStarted = false;
  let activeSessionConfig = null;
  let suppressCloseNotification = false;

  function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Gemini Live error:', error);
    callbacks.onError?.(message);
  }

  //send JSON messages to Gemini's websocket
  function send(message) {
    if (websocket?.readyState !== WebSocket.OPEN) return false;
    websocket.send(JSON.stringify(message));
    return true;
  }

  //create analyzer for mouth movement
  function ensurePlaybackAnalyser() {
    if (!audioContext || playbackAnalyser) return;

    try {
      playbackAnalyser = audioContext.createAnalyser();
      playbackAnalyser.fftSize = 256;
      // Keep the analyser responsive; the layered avatar animator owns the
      // visible attack/release envelope.
      playbackAnalyser.smoothingTimeConstant = 0;
      playbackAnalyserData = new Uint8Array(playbackAnalyser.fftSize);
      playbackAnalyser.connect(audioContext.destination);
    } catch (error) {
      playbackAnalyser = null;
      playbackAnalyserData = null;
      if (!playbackAnalyserWarningShown) {
        console.warn('Avatar audio visualizer unavailable; continuing with voice only.', error);
        playbackAnalyserWarningShown = true;
      }
    }
  }

  function stopPlaybackLevelLoop() {
    if (playbackLevelFrame !== null) {
      cancelAnimationFrame(playbackLevelFrame);
      playbackLevelFrame = null;
    }

    playbackLevelGeneration += 1;
    playbackLevelState = { responsePeak: 0 };
    callbacks.onAudioLevel?.(0);
  }

  // Calculate the playback level used by the local mouth overlay.
  function readPlaybackLevel(generation) {
    if (
      generation !== playbackLevelGeneration ||
      !playbackAnalyser ||
      !playbackAnalyserData
    ) {
      return;
    }

    playbackAnalyser.getByteTimeDomainData(playbackAnalyserData);

    let sum = 0;
    for (const value of playbackAnalyserData) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / playbackAnalyserData.length);
    const normalized = normalizePlaybackLevel(rms, playbackLevelState);
    playbackLevelState = normalized.state;
    callbacks.onAudioLevel?.(normalized.level);

    playbackLevelFrame = requestAnimationFrame(() => readPlaybackLevel(generation));
  }

  function startPlaybackLevelLoop() {
    ensurePlaybackAnalyser();
    if (!playbackAnalyser || playbackLevelFrame !== null) return;

    const generation = ++playbackLevelGeneration;
    playbackLevelFrame = requestAnimationFrame(() => readPlaybackLevel(generation));
  }

  function maybeFinishTurn() {
    if (!turnCompletePending || playbackSources.size > 0) return;

    stopPlaybackLevelLoop();
    turnCompletePending = false;
    responseStarted = false;
    callbacks.onTurnComplete?.();
  }

  function stopPlayback(notify = false) {
    playbackGeneration += 1;
    stopPlaybackLevelLoop();

    for (const source of playbackSources) {
      try {
        source.stop();
      } catch (_) { }
    }

    playbackSources.clear();
    turnCompletePending = false;
    responseStarted = false;
    nextPlaybackTime = audioContext ? audioContext.currentTime : 0;

    if (notify) callbacks.onPlaybackInterrupted?.();
  }

  function enqueueAudio(base64Audio) {
    const pcm = decodePcm16(base64Audio);
    if (!pcm.length) return;

    if (!audioContext) return;

    ensurePlaybackAnalyser();

    // Once Uni starts responding, stop sending microphone audio to avoid
    // feeding speaker echo back into the same Live session.
    if (isCapturing) {
      stopCapture();
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => { });
    }

    if (!responseStarted) {
      responseStarted = true;
      playbackLevelState = { responsePeak: 0 };
      callbacks.onAudioStart?.();
    }

    const buffer = audioContext.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = pcm[i] / 32768;
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackAnalyser || audioContext.destination);

    const generation = playbackGeneration;
    const startAt = Math.max(nextPlaybackTime, audioContext.currentTime + 0.02);
    nextPlaybackTime = startAt + buffer.duration;
    playbackSources.add(source);

    source.onended = () => {
      playbackSources.delete(source);
      if (generation === playbackGeneration) {
        maybeFinishTurn();
      }
    };

    source.start(startAt);
    startPlaybackLevelLoop();
  }

  function handleToolCall(toolCall) {
    const functionResponses = [];
    for (const functionCall of toolCall?.functionCalls || []) {
      let response;
      if (functionCall.name === AVATAR_ANIMATION_TOOL) {
        const requested = functionCall.args?.animation;
        const animation = AVATAR_ANIMATIONS.has(requested) ? requested : 'neutral';
        callbacks.onAvatarGesture?.(animation);
        response = { result: { status: 'played', animation } };
      } else {
        response = { error: `Unsupported local tool: ${functionCall.name}` };
      }

      functionResponses.push({
        id: functionCall.id,
        name: functionCall.name,
        response,
      });
    }

    if (functionResponses.length) {
      send({ toolResponse: { functionResponses } });
    }
  }

  async function handleMessage(event) {
    const raw = typeof event.data === 'string' ? event.data : await event.data.text();
    let response;

    try {
      response = JSON.parse(raw);
    } catch (_) {
      reportError(new Error('The Gemini Live API returned an invalid response.'));
      return;
    }

    if (response.setupComplete) {
      setupReady = true;
      callbacks.onConnected?.();
      if (connectPromise?.resolve) connectPromise.resolve();
      return;
    }

    if (response.error) {
      const error = new Error(getServerError(response));
      if (!setupReady && connectPromise?.reject) {
        connectPromise.reject(error);
      }
      reportError(error);
      return;
    }

    if (response.toolCall) handleToolCall(response.toolCall);

    const serverContent = response.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      stopPlayback();
      callbacks.onInterrupted?.();
    }

    for (const part of serverContent.modelTurn?.parts || []) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        enqueueAudio(inlineData.data);
      }
    }

    if (serverContent.turnComplete || serverContent.generationComplete) {
      turnCompletePending = true;
      maybeFinishTurn();
    }
  }

  function sendSetup(model, systemPrompt, voiceName) {
    return send({
      setup: {
        model: 'models/' + model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: 'vi-VN',
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            prefixPaddingMs: 120,
            silenceDurationMs: 600,
          },
        },
        systemInstruction: {
          parts: [{
            text: systemPrompt,
          }],
        },
        tools: [{
          functionDeclarations: [{
            name: AVATAR_ANIMATION_TOOL,
            description:
              'Play one short local mascot gesture when it meaningfully supports the spoken reply. ' +
              'Use at most once per reply and do not call it for every sentence.',
            parameters: {
              type: 'OBJECT',
              properties: {
                animation: {
                  type: 'STRING',
                  enum: ['wave', 'celebrate', 'emphasize', 'neutral'],
                  description:
                    'wave for greetings, celebrate for success, emphasize for an important point, neutral to reset.',
                },
              },
              required: ['animation'],
            },
          }],
        }],
        sessionResumption: {},
      },
    });
  }

  //check two sessions if the same or not
  function hasSameSessionConfig(left, right) {
    return Boolean(
      left &&
      right &&
      left.voiceName === right.voiceName &&
      left.systemPrompt === right.systemPrompt
    );
  }

  //close the current session because changed settings
  async function closeForConfigurationChange() {
    stopRequested = true;
    suppressCloseNotification = true;
    stopCapture();
    stopPlayback();

    const socket = websocket;
    if (!socket || ![WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
      websocket = null;
      setupReady = false;
      activeSessionConfig = null;
      suppressCloseNotification = false;
      stopRequested = false;
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const existingOnClose = socket.onclose;
      socket.onclose = (event) => {
        existingOnClose?.(event);
        finish();
      };

      try {
        socket.close(1000, 'Settings changed');
      } catch (_) {
        finish();
      }
    });

    websocket = null;
    setupReady = false;
    activeSessionConfig = null;
    suppressCloseNotification = false;
    stopRequested = false;
  }

  async function connect(sessionConfig = {}) {
    const normalizedConfig = normalizeSessionConfig(sessionConfig);

    if (connectPromise) return connectPromise.promise;

    if (setupReady && websocket?.readyState === WebSocket.OPEN) {
      if (hasSameSessionConfig(activeSessionConfig, normalizedConfig)) return;
      await closeForConfigurationChange();
    }

    stopRequested = false;
    const connectionOperation = operationId;

    let resolveConnect;
    let rejectConnect;
    const promise = new Promise((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });

    // Store the promise and its callbacks so setup errors can fail it.
    connectPromise = { promise, resolve: resolveConnect, reject: rejectConnect };
    setupReady = false;
    const requestController = new AbortController();
    tokenRequestController = requestController;

    try {
      const backendOrigin = window.UNI_BACKEND_URL ||
        `${window.location.protocol}//${window.location.hostname}:3000`;
      const tokenResponse = await fetch(new URL('/api/live-token', backendOrigin), {
        method: 'POST',
        signal: requestController.signal,
      });
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.token) {
        throw new Error(tokenData.error || 'Unable to create a Gemini Live session.');
      }

      if (connectionOperation !== operationId || stopRequested) return;

      const accessToken = encodeURIComponent(tokenData.token);
      websocket = new WebSocket(LIVE_WS_URL + '?access_token=' + accessToken);

      websocket.onopen = () => {
        callbacks.onConnecting?.();
        let systemPrompt;
        try {
          systemPrompt = composeSystemPrompt(
            tokenData.system_prompt,
            normalizedConfig.systemPrompt,
          );
        } catch (error) {
          rejectConnect(error);
          return;
        }

        if (!sendSetup(
          tokenData.model || LIVE_MODEL,
          systemPrompt,
          normalizedConfig.voiceName,
        )) {
          rejectConnect(new Error('Unable to send the Gemini Live configuration.'));
        } else {
          activeSessionConfig = normalizedConfig;
        }
      };

      websocket.onmessage = handleMessage;

      websocket.onerror = () => {
        if (stopRequested) return;
        const error = new Error('Unable to connect to the Gemini Live API.');
        if (!setupReady) rejectConnect(error);
        reportError(error);
      };

      websocket.onclose = (event) => {
        const stoppedByUser = stopRequested;
        const error = new Error(event.reason || 'The Gemini Live session ended.');
        if (!setupReady) {
          if (stoppedByUser) resolveConnect();
          else rejectConnect(error);
        }
        stopRequested = false;
        setupReady = false;
        activeSessionConfig = null;
        websocket = null;
        stopCapture();
        stopPlayback();
        if (suppressCloseNotification) return;
        if (stoppedByUser) {
          callbacks.onStopped?.();
        } else {
          callbacks.onDisconnected?.(event);
        }
      };

      await promise;
    } catch (error) {
      if (
        stopRequested &&
        connectionOperation !== operationId &&
        error?.name === 'AbortError'
      ) {
        return;
      }

      if (websocket) {
        try {
          websocket.close();
        } catch (_) { }
      }
      websocket = null;
      setupReady = false;
      activeSessionConfig = null;
      throw error;
    } finally {
      if (tokenRequestController === requestController) {
        tokenRequestController = null;
      }
      if (connectPromise?.promise === promise) {
        connectPromise = null;
      }
    }
  }

  async function ensureAudioCapture() {
    if (microphoneStream && captureNode) return;

    audioContext ||= new AudioContext();
    ensurePlaybackAnalyser();
    await audioContext.resume();

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    workletUrl ||= URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    );
    await audioContext.audioWorklet.addModule(workletUrl);

    microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
    captureNode = new AudioWorkletNode(audioContext, AUDIO_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    captureNode.port.onmessage = (event) => {
      if (!isCapturing) return;
      send({
        realtimeInput: {
          audio: {
            data: encodeBase64(event.data),
            mimeType: 'audio/pcm;rate=' + INPUT_SAMPLE_RATE,
          },
        },
      });
    };

    microphoneSource.connect(captureNode);
    captureNode.connect(muteNode);
    muteNode.connect(audioContext.destination);
  }

  function stopCapture() {
    isCapturing = false;

    try {
      microphoneSource?.disconnect();
      captureNode?.disconnect();
      muteNode?.disconnect();
    } catch (_) { }

    microphoneSource = null;
    captureNode = null;
    muteNode = null;

    for (const track of microphoneStream?.getTracks() || []) {
      track.stop();
    }
    microphoneStream = null;
  }

  async function startListening(sessionConfig = {}) {
    const currentOperation = ++operationId;
    await connect(sessionConfig);
    if (currentOperation !== operationId || !setupReady) return;

    await ensureAudioCapture();
    if (currentOperation !== operationId || !setupReady || stopRequested) {
      stopCapture();
      return;
    }

    isCapturing = true;
    callbacks.onListening?.();
  }

  function stopSession() {
    operationId += 1;
    stopRequested = true;
    const wasConnecting = Boolean(connectPromise && !websocket);
    tokenRequestController?.abort();
    stopCapture();
    stopPlayback(true);

    if (websocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(websocket.readyState)) {
      try {
        websocket.close(1000, 'Stopped by user');
      } catch (_) {
        stopRequested = false;
        websocket = null;
        callbacks.onStopped?.();
      }
      return;
    }

    if (wasConnecting) {
      callbacks.onStopped?.();
      return;
    }

    stopRequested = false;
    websocket = null;
    setupReady = false;
    activeSessionConfig = null;
    callbacks.onStopped?.();
  }

  function destroy() {
    operationId += 1;
    stopRequested = true;
    tokenRequestController?.abort();
    stopCapture();
    stopPlayback();
    if (websocket) {
      try {
        websocket.close();
      } catch (_) { }
    }
    websocket = null;
    setupReady = false;
    activeSessionConfig = null;
    if (workletUrl) {
      URL.revokeObjectURL(workletUrl);
      workletUrl = null;
    }
    if (audioContext) {
      try {
        playbackAnalyser?.disconnect();
      } catch (_) { }
      playbackAnalyser = null;
      playbackAnalyserData = null;
      audioContext.close().catch(() => { });
      audioContext = null;
    }
  }

  return {
    connect,
    startListening,
    stop: stopSession,
    destroy,
    isConnected: () => setupReady && websocket?.readyState === WebSocket.OPEN,
    isListening: () => isCapturing,
  };
}
