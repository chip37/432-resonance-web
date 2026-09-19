"use client";

import { useEffect, useRef, useState } from "react";
import { useRemoteControl } from "./useRemoteControl";

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
  audioContextState: string;
  sampleRate: number;
  channelCount: number;
  receivedFrames: number;
  receivedPeak: number;
  queuedFrames: number;
  clientUnderflows: number;
  clientDrops: number;
  workletRenderCallbacks: number;
  workletOutputPeak: number;
  workletPrimed: boolean;
  workletProcessorError: string;
};

const initialDiagnostics: Diagnostics = {
  connectionState: "closed",
  secureContext: false,
  audioWorkletAvailable: false,
  audioContextSampleRate: 0,
  audioContextState: "unavailable",
  sampleRate: 0,
  channelCount: 0,
  receivedFrames: 0,
  receivedPeak: 0,
  queuedFrames: 0,
  clientUnderflows: 0,
  clientDrops: 0,
  workletRenderCallbacks: 0,
  workletOutputPeak: 0,
  workletPrimed: false,
  workletProcessorError: "none",
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

function formatMusicDuration(duration: number) {
  const totalSeconds = Math.max(0, Math.round(duration));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const userInitiatedStopRef = useRef(false);
  const contextRef = useRef<AudioContext | null>(null);
  const contextStateChangeHandlerRef = useRef<(() => void) | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const enqueuePCMRef = useRef<((left: Float32Array, right: Float32Array) => void) | null>(null);
  const metadataRef = useRef<StreamMetadata | null>(null);
  const receivedFramesRef = useRef(0);
  const [websocketURL, setWebsocketURL] = useState("");
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [message, setMessage] = useState("Ready to connect.");
  const [pairingTokenInput, setPairingTokenInput] = useState("");
  const [musicSearchQuery, setMusicSearchQuery] = useState("");
  const remoteControl = useRemoteControl();

  useEffect(() => {
    setWebsocketURL(websocketURLForPage());
    setDiagnostics((current) => ({
      ...current,
      secureContext: window.isSecureContext,
    }));
    return () => {
      userInitiatedStopRef.current = true;
      socketRef.current?.close();
      if (contextRef.current && contextStateChangeHandlerRef.current) {
        contextRef.current.removeEventListener(
          "statechange",
          contextStateChangeHandlerRef.current
        );
      }
      contextStateChangeHandlerRef.current = null;
      if (workletRef.current) workletRef.current.onprocessorerror = null;
      workletRef.current?.disconnect();
      scriptProcessorRef.current?.disconnect();
      void contextRef.current?.close();
    };
  }, []);

  async function stop() {
    userInitiatedStopRef.current = true;
    socketRef.current?.close();
    socketRef.current = null;
    if (contextRef.current && contextStateChangeHandlerRef.current) {
      contextRef.current.removeEventListener(
        "statechange",
        contextStateChangeHandlerRef.current
      );
    }
    contextStateChangeHandlerRef.current = null;
    if (workletRef.current) workletRef.current.onprocessorerror = null;
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
      const handleContextStateChange = () => {
        setDiagnostics((current) => ({
          ...current,
          audioContextState: String(context.state),
        }));
      };
      contextStateChangeHandlerRef.current = handleContextStateChange;
      context.addEventListener("statechange", handleContextStateChange);
      handleContextStateChange();
      await context.resume();
      handleContextStateChange();
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
            workletRenderCallbacks: event.data.workletRenderCallbacks,
            workletOutputPeak: event.data.workletOutputPeak,
            workletPrimed: event.data.workletPrimed,
          }));
        };
        worklet.onprocessorerror = () => {
          setDiagnostics((current) => ({
            ...current,
            workletProcessorError: "occurred",
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
      userInitiatedStopRef.current = false;

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
        let receivedPeak = 0;
        for (let frame = 0; frame < frameCount; frame += 1) {
          left[frame] = interleaved[frame * 2];
          right[frame] = interleaved[frame * 2 + 1];
          receivedPeak = Math.max(
            receivedPeak,
            Math.abs(left[frame]),
            Math.abs(right[frame])
          );
        }

        receivedFramesRef.current += frameCount;
        setDiagnostics((current) => ({
          ...current,
          receivedFrames: receivedFramesRef.current,
          receivedPeak,
        }));
        enqueuePCMRef.current?.(left, right);
      };

      socket.onerror = () => {
        setDiagnostics((current) => ({ ...current, connectionState: "error" }));
        setMessage(`WebSocket connection failed for ${targetURL}. Confirm Start Processing is active and the Mac is reachable.`);
      };

      socket.onclose = () => {
        if (userInitiatedStopRef.current) return;
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

  const isPlaying =
    diagnostics.connectionState === "connected" &&
    diagnostics.receivedFrames > 0;
  const isConnected = diagnostics.connectionState === "connected";
  const isConnecting = diagnostics.connectionState === "connecting";
  const isStreamOffline =
    (diagnostics.connectionState === "closed" && message === "Connection closed.") ||
    (diagnostics.connectionState === "error" &&
      message.startsWith("WebSocket connection failed"));
  const hasBrowserError =
    diagnostics.connectionState === "error" && !isStreamOffline;

  const status = isPlaying
    ? {
        key: "playing",
        title: "Playing",
        description: "Receiving processed 432 Hz audio",
      }
    : isConnected
      ? {
          key: "connected",
          title: "Connected",
          description: "Waiting for processed audio…",
        }
      : isConnecting
        ? {
            key: "connecting",
            title: "Connecting",
            description: "Reaching your 432 Resonance stream…",
          }
        : isStreamOffline
          ? {
              key: "offline",
              title: "Stream Offline",
              description: "Start Processing on your Mac, then try again.",
            }
          : hasBrowserError
            ? {
                key: "error",
                title: "Error",
                description:
                  "Unable to start browser audio. Check your browser volume and try again.",
              }
            : {
                key: "ready",
                title: "Ready to connect",
                description: "Listen to your processed audio from this device.",
              };

  const shouldStop = isConnected;
  const buttonLabel = shouldStop
    ? "Stop"
    : isConnecting
      ? "Connecting…"
      : isStreamOffline
        ? "Reconnect Audio"
        : hasBrowserError
          ? "Try Again"
          : "Connect Audio";

  return (
    <main>
      <div className="player-card">
        <header>
          <div className="brand-mark" aria-hidden="true">432</div>
          <div>
            <h1>432 Resonance</h1>
            <p className="eyebrow">Remote Player</p>
          </div>
        </header>

        <section className={`status-panel status-${status.key}`} aria-live="polite">
          <div className="status-heading">
            <span className="status-dot" aria-hidden="true" />
            <h2>{status.title}</h2>
          </div>
          <p>{status.description}</p>
        </section>

        <button
          className="primary-button"
          onClick={shouldStop ? stop : connectAndPlay}
          disabled={!websocketURL || isConnecting}
        >
          {buttonLabel}
        </button>

        <details>
          <summary>Technical details</summary>
          <div className="diagnostics">
            <p><code>websocketURL=</code>{websocketURL || "unavailable"}</p>
            {(Object.keys(diagnostics) as Array<keyof Diagnostics>).map((key) => (
              <p key={key}><code>{key}=</code>{String(diagnostics[key])}</p>
            ))}
            <p><code>lastMessage=</code>{message}</p>
          </div>
        </details>

        <section className="remote-control-section" aria-labelledby="remote-control-title">
          <div className="section-heading">
            <div>
              <p className="section-label">Mac status</p>
              <h2 id="remote-control-title">Remote Control</h2>
            </div>
            <span
              className={`connection-badge ${remoteControl.authenticated ? "is-connected" : ""}`}
            >
              {remoteControl.authenticated ? "Mac Connected" : "Mac Disconnected"}
            </span>
          </div>

          {!remoteControl.authenticated ? (
            <form
              className="pairing-form"
              onSubmit={(event) => {
                event.preventDefault();
                remoteControl.pairMac(pairingTokenInput);
                setPairingTokenInput("");
              }}
            >
              <label htmlFor="pairing-token">Pairing token</label>
              <input
                id="pairing-token"
                type="password"
                value={pairingTokenInput}
                onChange={(event) => setPairingTokenInput(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={remoteControl.hasPairingToken ? "Enter a new token to retry" : "Paste token from the Mac app"}
                disabled={
                  remoteControl.connectionState === "connecting" ||
                  remoteControl.connectionState === "authenticating"
                }
              />
              <button
                className="secondary-button"
                type="submit"
                disabled={
                  !pairingTokenInput.trim() ||
                  remoteControl.connectionState === "connecting" ||
                  remoteControl.connectionState === "authenticating"
                }
              >
                {remoteControl.connectionState === "connecting" ||
                remoteControl.connectionState === "authenticating"
                  ? "Pairing…"
                  : "Pair Mac"}
              </button>
              {remoteControl.hasPairingToken && (
                <button
                  className="text-button"
                  type="button"
                  onClick={remoteControl.forgetPairedMac}
                >
                  Forget saved pairing
                </button>
              )}
            </form>
          ) : (
            <div className="remote-status">
              <div className="status-grid">
                <p><span>Readiness</span><strong>{remoteControl.macStatus?.ready ? "Ready" : "Not Ready"}</strong></p>
                <p><span>Processing</span><strong>{remoteControl.macStatus?.processing ? "Processing" : "Stopped"}</strong></p>
                <p><span>Output</span><strong>{remoteControl.macStatus?.activeOutput || "Unavailable"}</strong></p>
              </div>
              {remoteControl.macStatus?.notReadyReason && (
                <p className="remote-message">{remoteControl.macStatus.notReadyReason.message}</p>
              )}
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  if (remoteControl.macStatus?.processing) {
                    void remoteControl.stopProcessing();
                  } else {
                    void remoteControl.startProcessing();
                  }
                }}
                disabled={
                  remoteControl.processingCommand !== null ||
                  !remoteControl.macStatus ||
                  (!remoteControl.macStatus.processing && !remoteControl.macStatus.ready)
                }
              >
                {remoteControl.processingCommand === "starting"
                  ? "Starting…"
                  : remoteControl.processingCommand === "stopping"
                    ? "Stopping…"
                    : remoteControl.macStatus?.processing
                      ? "Stop Processing"
                      : "Start Processing"}
              </button>
              <div className="remote-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void remoteControl.refreshStatus()}
                >
                  Refresh Status
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={remoteControl.forgetPairedMac}
                >
                  Forget Paired Mac
                </button>
              </div>

              <section className="music-control-section" aria-labelledby="music-control-title">
                <p className="section-label">Apple Music</p>
                <h3 id="music-control-title">
                  {remoteControl.musicStatus?.running
                    ? remoteControl.musicStatus.title || "No track selected"
                    : remoteControl.musicCommand === "refresh"
                      ? "Checking Music…"
                      : "Music unavailable"}
                </h3>

                {remoteControl.musicStatus?.running && (
                  <div className="music-metadata">
                    <p>{remoteControl.musicStatus.artist || "Unknown artist"}</p>
                    <p>{remoteControl.musicStatus.album || "Unknown album"}</p>
                    <p className="music-playback-state">
                      {remoteControl.musicStatus.playbackState || "Unknown"}
                    </p>
                  </div>
                )}

                <div className="music-transport">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void remoteControl.musicPrevious()}
                    disabled={
                      remoteControl.musicCommand !== null ||
                      !remoteControl.musicStatus?.running
                    }
                  >
                    Previous
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void remoteControl.musicPlayPause()}
                    disabled={
                      remoteControl.musicCommand !== null ||
                      !remoteControl.musicStatus?.running
                    }
                  >
                    {remoteControl.musicCommand === "playPause"
                      ? "Working…"
                      : remoteControl.musicStatus?.playbackState.toLowerCase() === "playing"
                        ? "Pause"
                        : "Play"}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void remoteControl.musicNext()}
                    disabled={
                      remoteControl.musicCommand !== null ||
                      !remoteControl.musicStatus?.running
                    }
                  >
                    Next
                  </button>
                </div>

                <button
                  className="text-button"
                  type="button"
                  onClick={() => void remoteControl.refreshMusicStatus()}
                  disabled={remoteControl.musicCommand !== null}
                >
                  {remoteControl.musicCommand === "refresh"
                    ? "Refreshing…"
                    : "Refresh Music Status"}
                </button>

                {remoteControl.musicError && (
                  <p className="remote-error" role="alert">{remoteControl.musicError}</p>
                )}

                <div className="music-library-search">
                  <h4>Search Your Music Library</h4>
                  <form
                    className="music-search-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void remoteControl.musicSearch(musicSearchQuery);
                    }}
                  >
                    <input
                      type="search"
                      value={musicSearchQuery}
                      onChange={(event) => setMusicSearchQuery(event.target.value)}
                      placeholder="Song title or artist"
                      maxLength={256}
                      autoComplete="off"
                    />
                    <button
                      className="secondary-button"
                      type="submit"
                      disabled={
                        remoteControl.musicSearchPending ||
                        remoteControl.musicPlayTrackPendingID !== null ||
                        !musicSearchQuery.trim()
                      }
                    >
                      {remoteControl.musicSearchPending ? "Searching…" : "Search"}
                    </button>
                  </form>

                  {remoteControl.musicSearchMessage && (
                    <p className="music-search-message">{remoteControl.musicSearchMessage}</p>
                  )}
                  {remoteControl.musicSearchError && (
                    <p className="remote-error" role="alert">{remoteControl.musicSearchError}</p>
                  )}

                  {remoteControl.musicSearchResults.length > 0 && (
                    <div className="music-search-results">
                      {remoteControl.musicSearchResults.map((result) => (
                        <article className="music-search-result" key={result.persistentID}>
                          <div>
                            <h5>{result.title}</h5>
                            <p>{result.artist}</p>
                            <p>{result.album}</p>
                            {result.duration !== undefined && (
                              <p className="music-duration">
                                {formatMusicDuration(result.duration)}
                              </p>
                            )}
                          </div>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => void remoteControl.musicPlayTrack(result.persistentID)}
                            disabled={
                              remoteControl.musicSearchPending ||
                              remoteControl.musicPlayTrackPendingID !== null
                            }
                          >
                            {remoteControl.musicPlayTrackPendingID === result.persistentID
                              ? "Playing…"
                              : "Play"}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}

          {remoteControl.controlError && (
            <p className="remote-error" role="alert">{remoteControl.controlError}</p>
          )}
        </section>
      </div>
    </main>
  );
}
