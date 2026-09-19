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

export function useRemoteControl() {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>());
  const requestSequenceRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const authenticatedRef = useRef(false);
  const processingCommandRef = useRef<"starting" | "stopping" | null>(null);

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
    (command: string) => {
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
        socket.send(JSON.stringify({ version: 1, id, command }));
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
            .then((result) => setMacStatus(readMacStatus(result)))
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
            new Error(
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
        setConnectionState("disconnected");
        rejectPendingRequests("The Mac remote connection closed.");
        if (!wasAuthenticated) {
          setControlError(
            "Pairing failed or the Mac remote is unavailable. Check the token and try again."
          );
        }
      };
    },
    [rejectPendingRequests, sendRequest]
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
    pairMac,
    refreshStatus,
    startProcessing,
    stopProcessing,
    forgetPairedMac,
  };
}
