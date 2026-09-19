"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PRODUCTION_CONTROL_WEBSOCKET_URL =
  "wss://stream.getaicouncil.app/control";
const PAIRING_TOKEN_STORAGE_KEY = "resonancePairingToken";
const REQUEST_TIMEOUT_MS = 10_000;

type ControlConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "error";

type NotReadyReason = {
  code: string;
  message: string;
};

export type MacStatus = {
  online: boolean;
  ready: boolean;
  processing: boolean;
  activeOutput: string | null;
  notReadyReason: NotReadyReason | null;
};

export type MusicStatus = {
  running: boolean;
  playbackState: string;
  title: string;
  artist: string;
  album: string;
};

export type MusicSearchResult = {
  persistentID: string;
  title: string;
  artist: string;
  album: string;
  duration?: number;
};

type ControlResponse = {
  version: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class ControlRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ControlRequestError";
  }
}

function controlWebSocketURLForPage() {
  if (window.location.protocol === "https:") {
    return PRODUCTION_CONTROL_WEBSOCKET_URL;
  }
  return `ws://${window.location.hostname}:8765/control`;
}

function readMacStatus(value: unknown): MacStatus {
  if (!value || typeof value !== "object") {
    throw new Error("The Mac returned an invalid status response.");
  }

  const status = value as Record<string, unknown>;
  const reason = status.notReadyReason;
  let notReadyReason: NotReadyReason | null = null;
  if (reason && typeof reason === "object") {
    const fields = reason as Record<string, unknown>;
    notReadyReason = {
      code: typeof fields.code === "string" ? fields.code : "notReady",
      message:
        typeof fields.message === "string"
          ? fields.message
          : "The Mac is not ready to process audio.",
    };
  }

  return {
    online: status.online === true,
    ready: status.ready === true,
    processing: status.processing === true,
    activeOutput:
      typeof status.activeOutput === "string" ? status.activeOutput : null,
    notReadyReason,
  };
}

function readMusicStatus(value: unknown): MusicStatus {
  if (!value || typeof value !== "object") {
    throw new Error("The Mac returned an invalid Apple Music status.");
  }

  const status = value as Record<string, unknown>;
  return {
    running: status.running === true,
    playbackState:
      typeof status.playbackState === "string" ? status.playbackState : "unknown",
    title: typeof status.title === "string" ? status.title : "",
    artist: typeof status.artist === "string" ? status.artist : "",
    album: typeof status.album === "string" ? status.album : "",
  };
}

function readMusicSearchResponse(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("The Mac returned an invalid Music library response.");
  }

  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.results)) {
    throw new Error("The Mac returned invalid Music library results.");
  }

  const results = response.results.map((value): MusicSearchResult => {
    if (!value || typeof value !== "object") {
      throw new Error("The Mac returned an invalid Music library result.");
    }
    const result = value as Record<string, unknown>;
    if (typeof result.persistentID !== "string" || !result.persistentID) {
      throw new Error("The Mac returned a Music result without an identifier.");
    }
    return {
      persistentID: result.persistentID,
      title: typeof result.title === "string" ? result.title : "Unknown title",
      artist: typeof result.artist === "string" ? result.artist : "Unknown artist",
      album: typeof result.album === "string" ? result.album : "Unknown album",
      duration:
        typeof result.duration === "number" && Number.isFinite(result.duration)
          ? result.duration
          : undefined,
    };
  });

  return {
    results,
    message: typeof response.message === "string" ? response.message : null,
  };
}

function musicErrorMessage(error: unknown) {
  if (error instanceof ControlRequestError) {
    switch (error.code) {
      case "musicNotRunning":
        return "Open Music on your Mac.";
      case "musicPermissionDenied":
        return "Music control permission is required on the Mac.";
      case "musicUnavailable":
        return "Apple Music control is unavailable on the Mac.";
      case "musicTrackUnavailable":
        return "That track is no longer available in your Music library.";
      case "invalidArguments":
        return "The Music library request was invalid. Check your search and try again.";
      default:
        return error.message;
    }
  }
  return error instanceof Error
    ? error.message
    : "Apple Music could not be controlled from the Mac.";
}

export function useRemoteControl() {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>());
  const requestSequenceRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const authenticatedRef = useRef(false);
  const processingCommandRef = useRef<"starting" | "stopping" | null>(null);
  const musicCommandRef = useRef<
    "refresh" | "playPause" | "previous" | "next" | null
  >(null);
  const musicSearchPendingRef = useRef(false);
  const musicPlayTrackPendingRef = useRef<string | null>(null);

  const [controlURL, setControlURL] = useState("");
  const [connectionState, setConnectionState] =
    useState<ControlConnectionState>("disconnected");
  const [hasPairingToken, setHasPairingToken] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [macStatus, setMacStatus] = useState<MacStatus | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [processingCommand, setProcessingCommand] = useState<
    "starting" | "stopping" | null
  >(null);
  const [musicStatus, setMusicStatus] = useState<MusicStatus | null>(null);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [musicCommand, setMusicCommand] = useState<
    "refresh" | "playPause" | "previous" | "next" | null
  >(null);
  const [musicSearchResults, setMusicSearchResults] = useState<MusicSearchResult[]>([]);
  const [musicSearchPending, setMusicSearchPending] = useState(false);
  const [musicSearchMessage, setMusicSearchMessage] = useState<string | null>(null);
  const [musicSearchError, setMusicSearchError] = useState<string | null>(null);
  const [musicPlayTrackPendingID, setMusicPlayTrackPendingID] = useState<string | null>(null);

  const rejectPendingRequests = useCallback((message: string) => {
    for (const request of pendingRequestsRef.current.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pendingRequestsRef.current.clear();
  }, []);

  const nextRequestID = useCallback(() => {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    requestSequenceRef.current += 1;
    return `request-${requestSequenceRef.current}`;
  }, []);

  const sendRequest = useCallback(
    (command: string, fields: Record<string, unknown> = {}) => {
      const socket = socketRef.current;
      if (
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        !authenticatedRef.current
      ) {
        return Promise.reject(new Error("The Mac remote is not connected."));
      }

      const id = nextRequestID();
      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequestsRef.current.delete(id);
          reject(new Error("The Mac did not respond within 10 seconds."));
        }, REQUEST_TIMEOUT_MS);

        pendingRequestsRef.current.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ version: 1, id, command, ...fields }));
      });
    },
    [nextRequestID]
  );

  const refreshStatus = useCallback(async () => {
    setControlError(null);
    try {
      const result = await sendRequest("status");
      setMacStatus(readMacStatus(result));
    } catch (error) {
      setControlError(
        error instanceof Error ? error.message : "Could not refresh Mac status."
      );
    }
  }, [sendRequest]);

  const runProcessingCommand = useCallback(
    async (command: "startProcessing" | "stopProcessing") => {
      if (processingCommandRef.current) return;

      const pendingState = command === "startProcessing" ? "starting" : "stopping";
      processingCommandRef.current = pendingState;
      setProcessingCommand(pendingState);
      setControlError(null);

      try {
        await sendRequest(command);
        const status = await sendRequest("status");
        setMacStatus(readMacStatus(status));
      } catch (error) {
        setControlError(
          error instanceof Error
            ? error.message
            : command === "startProcessing"
              ? "Could not start Processing on the Mac."
              : "Could not stop Processing on the Mac."
        );
      } finally {
        processingCommandRef.current = null;
        setProcessingCommand(null);
      }
    },
    [sendRequest]
  );

  const startProcessing = useCallback(
    () => runProcessingCommand("startProcessing"),
    [runProcessingCommand]
  );

  const stopProcessing = useCallback(
    () => runProcessingCommand("stopProcessing"),
    [runProcessingCommand]
  );

  const requestMusicStatus = useCallback(async () => {
    const result = await sendRequest("musicStatus");
    const status = readMusicStatus(result);
    setMusicStatus(status);
    return status;
  }, [sendRequest]);

  const refreshMusicStatus = useCallback(async () => {
    if (musicCommandRef.current) return;

    musicCommandRef.current = "refresh";
    setMusicCommand("refresh");
    setMusicError(null);
    try {
      await requestMusicStatus();
    } catch (error) {
      setMusicStatus(null);
      setMusicError(musicErrorMessage(error));
    } finally {
      musicCommandRef.current = null;
      setMusicCommand(null);
    }
  }, [requestMusicStatus]);

  const runMusicCommand = useCallback(
    async (
      command: "musicPlayPause" | "musicPrevious" | "musicNext",
      pendingState: "playPause" | "previous" | "next"
    ) => {
      if (musicCommandRef.current) return;

      musicCommandRef.current = pendingState;
      setMusicCommand(pendingState);
      setMusicError(null);
      try {
        await sendRequest(command);
        await requestMusicStatus();
      } catch (error) {
        setMusicStatus(null);
        setMusicError(musicErrorMessage(error));
      } finally {
        musicCommandRef.current = null;
        setMusicCommand(null);
      }
    },
    [requestMusicStatus, sendRequest]
  );

  const musicPlayPause = useCallback(
    () => runMusicCommand("musicPlayPause", "playPause"),
    [runMusicCommand]
  );

  const musicPrevious = useCallback(
    () => runMusicCommand("musicPrevious", "previous"),
    [runMusicCommand]
  );

  const musicNext = useCallback(
    () => runMusicCommand("musicNext", "next"),
    [runMusicCommand]
  );

  const musicSearch = useCallback(
    async (query: string) => {
      if (musicSearchPendingRef.current) return;

      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        setMusicSearchError("Enter a song title or artist.");
        return;
      }
      if (trimmedQuery.length > 256) {
        setMusicSearchError("Search text must be 256 characters or fewer.");
        return;
      }

      musicSearchPendingRef.current = true;
      setMusicSearchPending(true);
      setMusicSearchError(null);
      setMusicSearchMessage(null);
      try {
        const response = await sendRequest("musicSearch", { query: trimmedQuery });
        const search = readMusicSearchResponse(response);
        setMusicSearchResults(search.results);
        setMusicSearchMessage(
          search.message ||
            (search.results.length === 0
              ? "No songs found in your Music library."
              : null)
        );
      } catch (error) {
        setMusicSearchError(musicErrorMessage(error));
      } finally {
        musicSearchPendingRef.current = false;
        setMusicSearchPending(false);
      }
    },
    [sendRequest]
  );

  const musicPlayTrack = useCallback(
    async (persistentID: string) => {
      if (musicPlayTrackPendingRef.current) return;

      if (typeof persistentID !== "string" || !persistentID) {
        setMusicSearchError("That Music library result is invalid.");
        return;
      }

      musicPlayTrackPendingRef.current = persistentID;
      setMusicPlayTrackPendingID(persistentID);
      setMusicSearchError(null);
      try {
        await sendRequest("musicPlayTrack", { persistentID });
        await requestMusicStatus();
      } catch (error) {
        setMusicSearchError(musicErrorMessage(error));
      } finally {
        musicPlayTrackPendingRef.current = null;
        setMusicPlayTrackPendingID(null);
      }
    },
    [requestMusicStatus, sendRequest]
  );

  const connect = useCallback(
    (token: string) => {
      const trimmedToken = token.trim();
      if (!trimmedToken) {
        setControlError("Enter the pairing token shown by 432 Resonance on your Mac.");
        return;
      }

      connectionGenerationRef.current += 1;
      const generation = connectionGenerationRef.current;
      socketRef.current?.close();
      rejectPendingRequests("The Mac remote connection was replaced.");
      authenticatedRef.current = false;
      setAuthenticated(false);
      setMacStatus(null);
      setControlError(null);
      setMusicStatus(null);
      setMusicError(null);
      setMusicSearchResults([]);
      setMusicSearchMessage(null);
      setMusicSearchError(null);
      setConnectionState("connecting");

      const targetURL = controlWebSocketURLForPage();
      setControlURL(targetURL);
      const socket = new WebSocket(targetURL);
      socketRef.current = socket;

      socket.onopen = () => {
        if (connectionGenerationRef.current !== generation) return;
        setConnectionState("authenticating");
        socket.send(JSON.stringify({ type: "authenticate", token: trimmedToken }));
      };

      socket.onmessage = (event) => {
        if (
          connectionGenerationRef.current !== generation ||
          typeof event.data !== "string"
        ) {
          return;
        }

        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          setControlError("The Mac returned an invalid control response.");
          return;
        }

        if (!message || typeof message !== "object") return;
        const object = message as Record<string, unknown>;

        if (
          !authenticatedRef.current &&
          object.version === 1 &&
          object.type === "authenticated"
        ) {
          authenticatedRef.current = true;
          setAuthenticated(true);
          setConnectionState("authenticated");
          void sendRequest("status")
            .then((result) => {
              setMacStatus(readMacStatus(result));
              void refreshMusicStatus();
            })
            .catch((error) =>
              setControlError(
                error instanceof Error
                  ? error.message
                  : "Could not read Mac status."
              )
            );
          return;
        }

        const response = object as unknown as ControlResponse;
        if (typeof response.id !== "string") return;
        const pending = pendingRequestsRef.current.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingRequestsRef.current.delete(response.id);

        if (response.ok) {
          pending.resolve(response.result);
        } else {
          pending.reject(
            new ControlRequestError(
              response.error?.code || "controlRequestFailed",
              response.error?.message || "The Mac rejected the control request."
            )
          );
        }
      };

      socket.onerror = () => {
        if (connectionGenerationRef.current !== generation) return;
        setConnectionState("error");
        setControlError("Could not connect to 432 Resonance on your Mac.");
      };

      socket.onclose = () => {
        if (connectionGenerationRef.current !== generation) return;
        const wasAuthenticated = authenticatedRef.current;
        authenticatedRef.current = false;
        setAuthenticated(false);
        setMacStatus(null);
        setMusicStatus(null);
        setMusicSearchResults([]);
        setMusicSearchMessage(null);
        setMusicSearchError(null);
        setConnectionState("disconnected");
        rejectPendingRequests("The Mac remote connection closed.");
        if (!wasAuthenticated) {
          setControlError(
            "Pairing failed or the Mac remote is unavailable. Check the token and try again."
          );
        }
      };
    },
    [refreshMusicStatus, rejectPendingRequests, sendRequest]
  );

  const pairMac = useCallback(
    (token: string) => {
      const trimmedToken = token.trim();
      if (!trimmedToken) {
        setControlError("Enter the pairing token shown by 432 Resonance on your Mac.");
        return;
      }
      localStorage.setItem(PAIRING_TOKEN_STORAGE_KEY, trimmedToken);
      setHasPairingToken(true);
      connect(trimmedToken);
    },
    [connect]
  );

  const forgetPairedMac = useCallback(() => {
    connectionGenerationRef.current += 1;
    localStorage.removeItem(PAIRING_TOKEN_STORAGE_KEY);
    socketRef.current?.close();
    socketRef.current = null;
    authenticatedRef.current = false;
    rejectPendingRequests("The paired Mac was forgotten.");
    setHasPairingToken(false);
    setAuthenticated(false);
    setMacStatus(null);
    setControlError(null);
    setMusicStatus(null);
    setMusicError(null);
    setMusicSearchResults([]);
    setMusicSearchMessage(null);
    setMusicSearchError(null);
    setConnectionState("disconnected");
  }, [rejectPendingRequests]);

  useEffect(() => {
    const targetURL = controlWebSocketURLForPage();
    setControlURL(targetURL);
    const storedToken = localStorage.getItem(PAIRING_TOKEN_STORAGE_KEY);
    if (storedToken) {
      setHasPairingToken(true);
      connect(storedToken);
    }

    return () => {
      connectionGenerationRef.current += 1;
      socketRef.current?.close();
      socketRef.current = null;
      authenticatedRef.current = false;
      rejectPendingRequests("The Mac remote was closed.");
    };
  }, [connect, rejectPendingRequests]);

  return {
    controlURL,
    connectionState,
    hasPairingToken,
    authenticated,
    macStatus,
    controlError,
    processingCommand,
    musicStatus,
    musicError,
    musicCommand,
    musicSearchResults,
    musicSearchPending,
    musicSearchMessage,
    musicSearchError,
    musicPlayTrackPendingID,
    pairMac,
    refreshStatus,
    startProcessing,
    stopProcessing,
    refreshMusicStatus,
    musicPlayPause,
    musicPrevious,
    musicNext,
    musicSearch,
    musicPlayTrack,
    forgetPairedMac,
  };
}
