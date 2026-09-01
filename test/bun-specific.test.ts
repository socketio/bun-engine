import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import {
  Server,
  type BunWebSocket,
  type WebSocketData,
  type RawData,
} from "../lib";
import { createWebSocket, waitFor } from "./util";

const PORT = 3002;
const URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;

function initEngine() {
  const engine = new Server({
    pingInterval: 300,
    pingTimeout: 200,
  });

  Bun.serve({
    port: PORT,
    fetch(req, server) {
      return engine.handleRequest(req, server);
    },
    websocket: {
      data: {} as WebSocketData,
      open(ws: BunWebSocket) {
        engine.onWebSocketOpen(ws);
      },
      message(ws: BunWebSocket, message: RawData) {
        engine.onWebSocketMessage(ws, message);
      },
      close(ws: BunWebSocket, code: number, message: string) {
        engine.onWebSocketClose(ws, code, message);
      },
    },
  });

  return engine;
}

describe("Bun-specific tests", () => {
  let engine: Server;

  beforeAll(() => {
    engine = initEngine();
  });

  beforeEach(() => {
    engine.off("connection");
  });

  describe("HTTP long-polling", () => {
    async function initLongPollingSession() {
      const response = await fetch(`${URL}/engine.io/?EIO=4&transport=polling`);
      const content = await response.text();
      return JSON.parse(content.substring(1)).sid;
    }

    async function testSendBinary(
      binary: ArrayBuffer | ArrayBufferView,
      expected: string,
    ) {
      engine.on("connection", (socket) => {
        socket.write(binary);
      });

      const sid = await initLongPollingSession();

      const pollResponse = await fetch(
        `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
      );
      expect(pollResponse.status).toEqual(200);
      const pollContent = await pollResponse.text();
      expect(pollContent).toEqual(expected);
    }

    it("sends Buffer", () => {
      return testSendBinary(Buffer.from([1, 2, 3]), "bAQID");
    });

    it("sends Uint8Array", () => {
      return testSendBinary(Uint8Array.from([4, 5, 6]), "bBAUG");
    });

    it("sends ArrayBuffer", () => {
      return testSendBinary(Uint8Array.from([7, 8, 9]).buffer, "bBwgJ");
    });

    it("sends partial Uint8Array view", () => {
      const buffer = Uint8Array.from([10, 11, 12]).buffer;
      return testSendBinary(new Uint8Array(buffer, 1, 1), "bCw==");
    });
  });

  describe("WebSocket", () => {
    async function testSendBinary(
      binary: ArrayBuffer | ArrayBufferView,
      expected: Uint8Array<ArrayBuffer>,
    ) {
      engine.on("connection", (socket) => {
        socket.write(binary);
      });

      const socket = createWebSocket(
        `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
      );
      socket.binaryType = "arraybuffer";
      await waitFor(socket, "message"); // handshake

      const { data } = await waitFor(socket, "message");
      expect(new Uint8Array(data as ArrayBuffer)).toEqual(expected);
      socket.close();
    }

    it("sends Buffer", () => {
      return testSendBinary(Buffer.from([1, 2, 3]), Uint8Array.from([1, 2, 3]));
    });

    it("sends Uint8Array", () => {
      return testSendBinary(
        Uint8Array.from([4, 5, 6]),
        Uint8Array.from([4, 5, 6]),
      );
    });

    it("sends ArrayBuffer", () => {
      return testSendBinary(
        Uint8Array.from([7, 8, 9]).buffer,
        Uint8Array.from([7, 8, 9]),
      );
    });

    it("sends partial Uint8Array view", () => {
      const buffer = Uint8Array.from([10, 11, 12]).buffer;
      return testSendBinary(
        new Uint8Array(buffer, 1, 1),
        Uint8Array.from([11]),
      );
    });
  });
});
