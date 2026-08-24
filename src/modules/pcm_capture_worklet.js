/*
 * Microphone capture processor loaded by AudioWorklet.
 *
 * Browser microphone contexts commonly run at 44.1kHz or 48kHz. Gemini Live
 * expects 16kHz signed 16-bit PCM input, so this processor resamples and emits
 * 20 ms chunks without doing work on the main UI thread.
 */

class UniPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.inputBuffer = [];
    this.position = 0;
    this.outputBuffer = [];
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let index = 0; index < channel.length; index += 1) {
      this.inputBuffer.push(channel[index]);
    }

    const resampled = [];
    while (this.position + 1 < this.inputBuffer.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const first = this.inputBuffer[index];
      const second = this.inputBuffer[index + 1];
      resampled.push(first + (second - first) * fraction);
      this.position += this.step;
    }

    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.inputBuffer = this.inputBuffer.slice(consumed);
      this.position -= consumed;
    }

    this.outputBuffer.push(...resampled);
    while (this.outputBuffer.length >= 320) {
      const pcm = new Int16Array(320);
      for (let index = 0; index < pcm.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, this.outputBuffer[index]));
        pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      this.outputBuffer.splice(0, 320);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('uni-pcm-capture', UniPcmCaptureProcessor);
