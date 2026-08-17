const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.' +
  'BidiGenerateContentConstrained';
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const OUTPUT_VOICE = 'Kore';
const AUDIO_WORKLET_NAME = 'uni-pcm-capture';
const FALLBACK_SYSTEM_PROMPT = [
  'Bạn là Uni, linh vật Live United.',
  'Luôn trả lời bằng tiếng Việt, trừ khi người dùng yêu cầu ngôn ngữ khác.',
  'Nói tự nhiên, thân thiện, tích cực và ngắn gọn, tối đa 1-2 câu.',
  'Không dùng Markdown, gạch đầu dòng, emoji hoặc câu trả lời chung chung.',
  'Luôn trả lời đúng vào điều người dùng vừa nói.',
].join(' ');

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

export function isLiveAudioSupported() {
  return Boolean(
    typeof window !== 'undefined' &&
    window.WebSocket &&
    window.AudioContext &&
    window.AudioWorkletNode &&
    navigator.mediaDevices?.getUserMedia
  );
}

function encodeBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

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

  let audioContext = null;
  let microphoneStream = null;
  let microphoneSource = null;
  let captureNode = null;
  let muteNode = null;
  let workletUrl = null;

  let playbackSources = new Set();
  let nextPlaybackTime = 0;
  let playbackGeneration = 0;
  let turnCompletePending = false;
  let responseStarted = false;

  function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Gemini Live error:', error);
    callbacks.onError?.(message);
  }

  function send(message) {
    if (websocket?.readyState !== WebSocket.OPEN) return false;
    websocket.send(JSON.stringify(message));
    return true;
  }

  function maybeFinishTurn() {
    if (!turnCompletePending || playbackSources.size > 0) return;

    turnCompletePending = false;
    responseStarted = false;
    callbacks.onTurnComplete?.();
  }

  function stopPlayback(notify = false) {
    playbackGeneration += 1;

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
    if (!audioContext) return;

    const pcm = decodePcm16(base64Audio);
    if (!pcm.length) return;

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
      callbacks.onAudioStart?.();
    }

    const buffer = audioContext.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = pcm[i] / 32768;
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

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

  function sendSetup(model, systemPrompt) {
    return send({
      setup: {
        model: 'models/' + model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: 'vi-VN',
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: OUTPUT_VOICE,
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
            text: systemPrompt || FALLBACK_SYSTEM_PROMPT,
          }],
        },
        sessionResumption: {},
      },
    });
  }

  async function connect() {
    if (setupReady && websocket?.readyState === WebSocket.OPEN) return;
    if (connectPromise) return connectPromise.promise;

    let resolveConnect;
    let rejectConnect;
    const promise = new Promise((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });

    // Store the promise and its callbacks so setup errors can fail it.
    connectPromise = { promise, resolve: resolveConnect, reject: rejectConnect };
    setupReady = false;

    try {
      const tokenResponse = await fetch('/api/live-token', { method: 'POST' });
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.token) {
        throw new Error(tokenData.error || 'Unable to create a Gemini Live session.');
      }

      const accessToken = encodeURIComponent(tokenData.token);
      websocket = new WebSocket(LIVE_WS_URL + '?access_token=' + accessToken);

      websocket.onopen = () => {
        callbacks.onConnecting?.();
        if (!sendSetup(tokenData.model || LIVE_MODEL, tokenData.system_prompt)) {
          rejectConnect(new Error('Unable to send the Gemini Live configuration.'));
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
        if (!setupReady) rejectConnect(error);
        stopRequested = false;
        setupReady = false;
        websocket = null;
        stopCapture();
        stopPlayback();
        if (stoppedByUser) {
          callbacks.onStopped?.();
        } else {
          callbacks.onDisconnected?.(event);
        }
      };

      await promise;
    } catch (error) {
      if (websocket) {
        try {
          websocket.close();
        } catch (_) { }
      }
      websocket = null;
      setupReady = false;
      throw error;
    } finally {
      connectPromise = null;
    }
  }

  async function ensureAudioCapture() {
    if (microphoneStream && captureNode) return;

    audioContext ||= new AudioContext();
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

  async function startListening() {
    const currentOperation = ++operationId;
    await connect();
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

    stopRequested = false;
    websocket = null;
    setupReady = false;
    callbacks.onStopped?.();
  }

  function destroy() {
    operationId += 1;
    stopRequested = true;
    stopCapture();
    stopPlayback();
    if (websocket) {
      try {
        websocket.close();
      } catch (_) { }
    }
    websocket = null;
    setupReady = false;
    if (workletUrl) {
      URL.revokeObjectURL(workletUrl);
      workletUrl = null;
    }
    if (audioContext) {
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
