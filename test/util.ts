export function sleep(delay: number) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

type ExtendedWebSocket = WebSocket & {
  _eventBuffer: Record<string, any[]>;
  _pendingPromises: Record<string, Array<(packet: any) => void>>;
};

type EventData = string | ArrayBuffer;

export function createWebSocket(url: string) {
  // see https://github.com/socketio/socket.io-protocol/issues/32
  const socket = new WebSocket(url) as ExtendedWebSocket;
  socket._eventBuffer = {};
  socket._pendingPromises = {};

  for (const eventType of ["open", "close", "message"]) {
    socket._eventBuffer[eventType] = [];
    socket._pendingPromises[eventType] = [];

    socket.addEventListener(eventType, (event) => {
      if (socket._pendingPromises[eventType]!.length) {
        socket._pendingPromises[eventType]!.shift()!(event);
      } else {
        socket._eventBuffer[eventType]!.push(event);
      }
    });
  }

  return socket;
}

export function waitFor(socket: ExtendedWebSocket, eventType: string) {
  if (socket._eventBuffer[eventType]!.length) {
    return Promise.resolve(socket._eventBuffer[eventType]!.shift());
  } else {
    return new Promise((resolve) => {
      socket._pendingPromises[eventType]!.push(resolve);
    });
  }
}

export function waitForPackets(socket: ExtendedWebSocket, count: number) {
  const packets: EventData[] = [];

  return new Promise<EventData[]>((resolve) => {
    const handler = (event: any) => {
      if (event.data === "2") {
        // ignore PING packets
        return;
      }
      packets.push(event.data);
      if (packets.length === count) {
        socket.removeEventListener("message", handler);
        resolve(packets);
      }
    };
    socket.addEventListener("message", handler);
  });
}
