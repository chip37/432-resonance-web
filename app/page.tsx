"use client";

import { useEffect, useRef, useState } from "react";

const EXPECTED_STREAM_SAMPLE_RATE = 44_100;
const PRODUCTION_WEBSOCKET_URL =
  "wss://stream.getaicouncil.app/audio";

function websocketURLForPage() {
  if (window.location.protocol === "https:") {
    return PRODUCTION_WEBSOCKET_URL;
  }
  return `ws://${window.location.hostname}:8765/audio`;
}

type StreamMetadata = {
  type: "audio-format";
  sampleRate: number;
  channelCount: number;
  sampleFormat: string;
};

type Diagnostics = {
  connectionState: string;
  secureContext: boolean;
  audioWorkletAvailable: boolean;
  audioContextSampleRate: number;
  sampleRate: number;
  channelCount: number;
  receivedFrames: number;
  queuedFrames: number;
  clientUnderflows: number;
  clientDrops: number;
};

const initialDiagnostics: Diagnostics = {
  connectionState: "closed",
  secureContext: false,
  audioWorkletAvailable: false,
  audioContextSampleRate: 0,
  sampleRate: 0,
  channelCount: 0,
  receivedFrames: 0,
  queuedFrames: 0,
  clientUnderflows: 0,
  clientDrops: 0,
};

class BoundedStereoPCMQueue {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private primed = false;
  queuedFrames = 0;
  clientUnderflows = 0;
  clientDrops = 0;

  constructor(
    private readonly capacityFrames: number,
    private readonly primeFrames: number
  ) {
    this.left = new Float32Array(capacityFrames);
    this.right = new Float32Array(capacityFrames);
  }

  push(left: Float32Array, right: Float32Array) {
    const incomingFrames = Math.min(left.length, right.length);
    let sourceOffset = Math.max(0, incomingFrames - this.capacityFrames);
    let framesToWrite = incomingFrames - sourceOffset;
    this.clientDrops += sourceOffset;

    const requiredDrop = Math.max(
      0,
      this.queuedFrames + framesToWrite - this.capacityFrames
    );
    if (requiredDrop > 0) {
      this.readIndex = (this.readIndex + requiredDrop) % this.capacityFrames;
      this.queuedFrames -= requiredDrop;
      this.clientDrops += requiredDrop;
    }

    for (let frame = 0; frame < framesToWrite; frame += 1) {
      this.left[this.writeIndex] = left[sourceOffset + frame];
      this.right[this.writeIndex] = right[sourceOffset + frame];
      this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
    }
    this.queuedFrames += framesToWrite;
  }

  pull(leftOutput: Float32Array, rightOutput: Float32Array) {
    if (!this.primed && this.queuedFrames >= this.primeFrames) {
      this.primed = true;
    }

    const requestedFrames = Math.min(leftOutput.length, rightOutput.length);
    const framesToRead = this.primed
      ? Math.min(requestedFrames, this.queuedFrames)
      : 0;
    if (this.primed && framesToRead < requestedFrames) {
      this.clientUnderflows += 1;
    }

    for (let frame = 0; frame < framesToRead; frame += 1) {
      leftOutput[frame] = this.left[this.readIndex];
      rightOutput[frame] = this.right[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacityFrames;
    }
    this.queuedFrames -= framesToRead;
    leftOutput.fill(0, framesToRead);
    rightOutput.fill(0, framesToRead);
  }
}

function browserIsLittleEndian() {
  const bytes = new Uint8Array(new Uint16Array([1]).buffer);
  return bytes[0] === 1;
}

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const enqueuePCMRef = useRef<((left: Float32Array, right: Float32Array) => void) | null>(null);
  const metadataRef = useRef<StreamMetadata | null>(null);
  const receivedFramesRef = useRef(0);
  const [websocketURL, setWebsocketURL] = useState("");
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [message, setMessage] = useState("Ready to connect.");

  useEffect(() => {
    setWebsocketURL(websocketURLForPage());
    setDiagnostics((current) => ({
      ...current,
      secureContext: window.isSecureContext,
    }));
    return () => {
      socketRef.current?.close();
      workletRef.current?.disconnect();
      scriptProcessorRef.current?.disconnect();
      void contextRef.current?.close();
    };
  }, []);

  async function stop() {
    socketRef.current?.close();
    socketRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    enqueuePCMRef.current = null;
    if (contextRef.current) {
      await contextRef.current.close();
      contextRef.current = null;
    }
    metadataRef.current = null;
    receivedFramesRef.current = 0;
    setDiagnostics({
      ...initialDiagnostics,
      secureContext: window.isSecureContext,
    });
    setMessage("Stopped.");
  }

  async function connectAndPlay() {
    await stop();
    setDiagnostics((current) => ({ ...current, connectionState: "connecting" }));
    const targetURL = websocketURLForPage();
    setWebsocketURL(targetURL);
    setMessage(`Connecting to ${targetURL}`);

    try {
      const context = new AudioContext({ sampleRate: EXPECTED_STREAM_SAMPLE_RATE });
      contextRef.current = context;
      await context.resume();
      const hasAudioWorklet = context.audioWorklet !== undefined;
      setDiagnostics((current) => ({
        ...current,
        secureContext: window.isSecureContext,
        audioWorkletAvailable: hasAudioWorklet,
        audioContextSampleRate: context.sampleRate,
      }));

      if (hasAudioWorklet) {
        await context.audioWorklet.addModule("/pcm-player-worklet.js");

        const worklet = new AudioWorkletNode(context, "pcm-player", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: {
            capacityFrames: Math.ceil(context.sampleRate * 0.25),
            primeFrames: Math.ceil(context.sampleRate * 0.15),
          },
        });
        worklet.connect(context.destination);
        worklet.port.onmessage = (event: MessageEvent) => {
          if (event.data?.type !== "diagnostics") return;
          setDiagnostics((current) => ({
            ...current,
            queuedFrames: event.data.queuedFrames,
            clientUnderflows: event.data.clientUnderflows,
            clientDrops: event.data.clientDrops,
          }));
        };
        workletRef.current = worklet;
        enqueuePCMRef.current = (left, right) => {
          worklet.port.postMessage(
            { type: "audio", left, right },
            [left.buffer, right.buffer]
          );
        };
      } else {
        // Temporary LAN compatibility fallback for browsers that do not expose
        // AudioWorklet on an insecure HTTP origin.
        const queue = new BoundedStereoPCMQueue(
          Math.ceil(context.sampleRate * 0.25),
          Math.ceil(context.sampleRate * 0.15)
        );
        const processor = context.createScriptProcessor(1_024, 0, 2);
        let diagnosticsCountdown = 10;
        processor.onaudioprocess = (event) => {
          queue.pull(
            event.outputBuffer.getChannelData(0),
            event.outputBuffer.getChannelData(1)
          );
          diagnosticsCountdown -= 1;
          if (diagnosticsCountdown <= 0) {
            setDiagnostics((current) => ({
              ...current,
              queuedFrames: queue.queuedFrames,
              clientUnderflows: queue.clientUnderflows,
              clientDrops: queue.clientDrops,
            }));
            diagnosticsCountdown = 10;
          }
        };
        processor.connect(context.destination);
        scriptProcessorRef.current = processor;
        enqueuePCMRef.current = (left, right) => queue.push(left, right);
      }

      const socket = new WebSocket(targetURL);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onopen = () => {
        setDiagnostics((current) => ({ ...current, connectionState: "connected" }));
        setMessage("Connected. Waiting for stream metadata.");
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const metadata = JSON.parse(event.data) as StreamMetadata;
            if (
              metadata.type !== "audio-format" ||
              metadata.sampleFormat !== "float32-le-interleaved" ||
              metadata.channelCount !== 2
            ) {
              throw new Error("Unsupported stream format.");
            }
            if (!browserIsLittleEndian()) {
              throw new Error("This proof requires a little-endian browser platform.");
            }
            if (context.sampleRate !== metadata.sampleRate) {
              throw new Error(
                `Sample-rate mismatch: stream=${metadata.sampleRate}, AudioContext=${context.sampleRate}. ` +
                  "Browser-side sample-rate conversion is not implemented."
              );
            }

            metadataRef.current = metadata;
            setDiagnostics((current) => ({
              ...current,
              sampleRate: metadata.sampleRate,
              channelCount: metadata.channelCount,
            }));
            setMessage("Metadata accepted. Priming approximately 150 ms of processed audio.");
          } catch (error) {
            setDiagnostics((current) => ({ ...current, connectionState: "error" }));
            setMessage(error instanceof Error ? error.message : "Invalid metadata.");
            socket.close();
          }
          return;
        }

        if (!(event.data instanceof ArrayBuffer) || !metadataRef.current) return;
        const interleaved = new Float32Array(event.data);
        const frameCount = Math.floor(interleaved.length / 2);
        if (frameCount === 0) return;

        const left = new Float32Array(frameCount);
        const right = new Float32Array(frameCount);
        for (let frame = 0; frame < frameCount; frame += 1) {
          left[frame] = interleaved[frame * 2];
          right[frame] = interleaved[frame * 2 + 1];
        }

        receivedFramesRef.current += frameCount;
        setDiagnostics((current) => ({
          ...current,
          receivedFrames: receivedFramesRef.current,
        }));
        enqueuePCMRef.current?.(left, right);
      };

      socket.onerror = () => {
        setDiagnostics((current) => ({ ...current, connectionState: "error" }));
        setMessage(`WebSocket connection failed for ${targetURL}. Confirm Start Processing is active and the Mac is reachable.`);
      };

      socket.onclose = () => {
        setDiagnostics((current) => ({
          ...current,
          connectionState: current.connectionState === "error" ? "error" : "closed",
        }));
        setMessage((current) => current.startsWith("WebSocket connection failed") ? current : "Connection closed.");
      };
    } catch (error) {
      setDiagnostics((current) => ({ ...current, connectionState: "error" }));
      setMessage(error instanceof Error ? error.message : "Could not start browser audio.");
    }
  }

  return (
    <main>
      <h1>432 Resonance Local Player</h1>
      <p>Processed audio from <code>{websocketURL || "Determining page host…"}</code></p>

      <div className="controls">
        <button onClick={connectAndPlay} disabled={!websocketURL || diagnostics.connectionState === "connecting" || diagnostics.connectionState === "connected"}>
          Connect / Play
        </button>
        <button onClick={stop} disabled={diagnostics.connectionState === "closed"}>
          Stop
        </button>
      </div>

      <p>{message}</p>
      <section>
        <p><code>websocketURL=</code>{websocketURL || "unavailable"}</p>
        {(Object.keys(diagnostics) as Array<keyof Diagnostics>).map((key) => (
          <p key={key}><code>{key}=</code>{diagnostics[key]}</p>
        ))}
      </section>
    </main>
  );
}
