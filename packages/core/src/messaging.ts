export interface RuntimeMessage<TPayload = unknown> {
  readonly target: string;
  readonly type: string;
  readonly payload?: TPayload;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
}

export type MessageResponse<T = unknown> =
  | { readonly ok: true; readonly value?: T }
  | { readonly ok: false; readonly error: SerializedError };

export interface RuntimeSender {
  readonly tab?: unknown;
  readonly url?: string;
}

export interface RuntimeMessageEvent {
  addListener(
    callback: (
      message: unknown,
      sender: RuntimeSender,
      sendResponse: (response: MessageResponse) => void,
    ) => boolean | void,
  ): void;
  removeListener?(
    callback: (
      message: unknown,
      sender: RuntimeSender,
      sendResponse: (response: MessageResponse) => void,
    ) => boolean | void,
  ): void;
}

export interface RuntimeMessenger {
  sendMessage<T = unknown>(message: unknown): Promise<T>;
  readonly onMessage: RuntimeMessageEvent;
}

export function createMessage<TPayload>(
  target: string,
  type: string,
  payload?: TPayload,
): RuntimeMessage<TPayload> {
  return payload === undefined
    ? { target, type }
    : { target, type, payload };
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { target?: unknown; type?: unknown };
  return (
    typeof candidate.target === "string" &&
    typeof candidate.type === "string"
  );
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

export type MessageHandler = (
  message: RuntimeMessage,
  sender: RuntimeSender,
) => unknown | Promise<unknown>;

/**
 * Chrome 138 requires returning true while an async sendResponse is pending.
 * The returned disposer is useful in long-lived documents and harmless in a
 * service worker.
 */
export function addTargetMessageListener(
  runtime: RuntimeMessenger,
  target: string,
  handlers: Readonly<Record<string, MessageHandler>>,
): () => void {
  const listener = (
    message: unknown,
    sender: RuntimeSender,
    sendResponse: (response: MessageResponse) => void,
  ): boolean | void => {
    if (!isRuntimeMessage(message) || message.target !== target) return;
    const handler = handlers[message.type];
    if (!handler) return;

    void Promise.resolve(handler(message, sender))
      .then((value) => {
        sendResponse(
          value === undefined ? { ok: true } : { ok: true, value },
        );
      })
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: serializeError(error) });
      });
    return true;
  };

  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener?.(listener);
}
