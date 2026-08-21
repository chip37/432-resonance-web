class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedCapacity = options.processorOptions?.capacityFrames ?? Math.ceil(sampleRate * 0.25);
    this.capacity = Math.max(128, requestedCapacity);
    this.primeFrames = Math.min(
      this.capacity,
      options.processorOptions?.primeFrames ?? Math.ceil(sampleRate * 0.15)
    );
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.queuedFrames = 0;
    this.clientUnderflows = 0;
    this.clientDrops = 0;
    this.primed = false;
    this.reportCountdown = Math.ceil(sampleRate / 128 / 4);

    this.port.onmessage = (event) => {
      if (event.data?.type !== "audio") return;
      this.enqueue(event.data.left, event.data.right);
    };
  }

  enqueue(left, right) {
    const incomingFrames = Math.min(left.length, right.length);
    if (incomingFrames <= 0) return;

    let sourceOffset = 0;
    let framesToWrite = incomingFrames;
    if (framesToWrite > this.capacity) {
      sourceOffset = framesToWrite - this.capacity;
      this.clientDrops += sourceOffset;
      framesToWrite = this.capacity;
    }

    const requiredDrop = Math.max(0, this.queuedFrames + framesToWrite - this.capacity);
    if (requiredDrop > 0) {
      this.readIndex = (this.readIndex + requiredDrop) % this.capacity;
      this.queuedFrames -= requiredDrop;
      this.clientDrops += requiredDrop;
    }

    for (let frame = 0; frame < framesToWrite; frame += 1) {
      this.left[this.writeIndex] = left[sourceOffset + frame];
      this.right[this.writeIndex] = right[sourceOffset + frame];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.queuedFrames += framesToWrite;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const leftOutput = output[0];
    const rightOutput = output[1];
    const requestedFrames = leftOutput.length;

    if (!this.primed && this.queuedFrames >= this.primeFrames) {
      this.primed = true;
    }

    let framesToRead = 0;
    if (this.primed) {
      framesToRead = Math.min(requestedFrames, this.queuedFrames);
      if (framesToRead < requestedFrames) this.clientUnderflows += 1;
    }

    for (let frame = 0; frame < framesToRead; frame += 1) {
      leftOutput[frame] = this.left[this.readIndex];
      rightOutput[frame] = this.right[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacity;
    }
    this.queuedFrames -= framesToRead;

    for (let frame = framesToRead; frame < requestedFrames; frame += 1) {
      leftOutput[frame] = 0;
      rightOutput[frame] = 0;
    }

    this.reportCountdown -= 1;
    if (this.reportCountdown <= 0) {
      this.port.postMessage({
        type: "diagnostics",
        queuedFrames: this.queuedFrames,
        clientUnderflows: this.clientUnderflows,
        clientDrops: this.clientDrops,
      });
      this.reportCountdown = Math.ceil(sampleRate / 128 / 4);
    }
    return true;
  }
}

registerProcessor("pcm-player", PCMPlayerProcessor);
