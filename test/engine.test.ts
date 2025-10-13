import { describe, it, expect, beforeAll } from "bun:test";
import {
  Server,
  type BunWebSocket,
  type WebSocketData,
  type RawData,
} from "../lib";
import { createWebSocket, waitFor, sleep } from "./util";
import { Hono } from "hono";
import { logger } from "hono/logger";

const URL = "http://localhost:3000";
const WS_URL = URL.replace("http", "ws");

const PING_INTERVAL = 300;
const PING_TIMEOUT = 200;

async function initLongPollingSession() {
  const response = await fetch(`${URL}/engine.io/?EIO=4&transport=polling`);
  const content = await response.text();
  return JSON.parse(content.substring(1)).sid;
}

function setup() {
  const engine = new Server({
    pingInterval: PING_INTERVAL,
    pingTimeout: PING_TIMEOUT,
  });

  engine.on("connection", (socket) => {
    socket.on("data", (data: RawData) => {
      socket.write(data);
    });
  });

  if (process.env.USE_HONO) {
    console.log("Using Hono framework");
    const app = new Hono();

    app.use(logger());

    app.all("/engine.io/", async (c) => {
      const request = c.req.raw;
      const server = c.env as Bun.Server<WebSocketData>;
      return engine.handleRequest(request, server);
    });

    Bun.serve({
      port: 3000,
      fetch: app.fetch,
      websocket: engine.handler().websocket,
    });
  } else {
    console.log("Using Bun's native HTTP server");

    Bun.serve({
      port: 3000,

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
  }
}

// imported from https://github.com/socketio/socket.io/blob/main/docs/engine.io-protocol/v4-test-suite
describe("Engine.IO protocol", () => {
  beforeAll(() => setup());

  describe("handshake", () => {
    describe("HTTP long-polling", () => {
      it("successfully opens a session", async () => {
        const response = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling`,
        );

        expect(response.status).toEqual(200);

        const content = await response.text();

        expect(content).toStartWith("0");

        const value = JSON.parse(content.substring(1));

        expect(value).toContainAllKeys([
          "sid",
          "upgrades",
          "pingInterval",
          "pingTimeout",
          "maxPayload",
        ]);
        expect(value.sid).toBeString();
        expect(value.upgrades).toEqual(["websocket"]);
        expect(value.pingInterval).toEqual(PING_INTERVAL);
        expect(value.pingTimeout).toEqual(PING_TIMEOUT);
        expect(value.maxPayload).toEqual(1000000);
      });

      it("fails with an invalid 'EIO' query parameter", async () => {
        const response = await fetch(`${URL}/engine.io/?transport=polling`);

        expect(response.status).toEqual(400);

        const response2 = await fetch(
          `${URL}/engine.io/?EIO=abc&transport=polling`,
        );

        expect(response2.status).toEqual(400);
      });

      it("fails with an invalid 'transport' query parameter", async () => {
        const response = await fetch(`${URL}/engine.io/?EIO=4`);

        expect(response.status).toEqual(400);

        const response2 = await fetch(`${URL}/engine.io/?EIO=4&transport=abc`);

        expect(response2.status).toEqual(400);
      });

      it("fails with an invalid request method", async () => {
        const response = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling`,
          {
            method: "post",
          },
        );

        expect(response.status).toEqual(400);

        const response2 = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling`,
          {
            method: "put",
          },
        );

        expect(response2.status).toEqual(400);
      });
    });

    describe("WebSocket", () => {
      it("successfully opens a session", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
        );

        const { data } = await waitFor(socket, "message");

        expect(data).toStartWith("0");

        const value = JSON.parse(data.substring(1));

        expect(value).toContainAllKeys([
          "sid",
          "upgrades",
          "pingInterval",
          "pingTimeout",
          "maxPayload",
        ]);
        expect(value.sid).toBeString();
        expect(value.upgrades).toEqual([]);
        expect(value.pingInterval).toEqual(PING_INTERVAL);
        expect(value.pingTimeout).toEqual(PING_TIMEOUT);
        expect(value.maxPayload).toEqual(1000000);

        socket.close();
      });

      it("fails with an invalid 'EIO' query parameter", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?transport=websocket`,
        );

        await waitFor(socket, "close");

        const socket2 = createWebSocket(
          `${WS_URL}/engine.io/?EIO=abc&transport=websocket`,
        );

        await waitFor(socket2, "close");
      });

      it("fails with an invalid 'transport' query parameter", async () => {
        const socket = createWebSocket(`${WS_URL}/engine.io/?EIO=4`);

        await waitFor(socket, "close");

        const socket2 = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=abc`,
        );

        await waitFor(socket2, "close");
      });
    });
  });

  describe("message", () => {
    describe("HTTP long-polling", () => {
      it("sends and receives a payload containing one plain text packet", async () => {
        const sid = await initLongPollingSession();

        const pushResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
          {
            method: "post",
            body: "4hello",
          },
        );

        expect(pushResponse.status).toEqual(200);

        const postContent = await pushResponse.text();

        expect(postContent).toEqual("ok");

        const pollResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse.status).toEqual(200);

        const pollContent = await pollResponse.text();

        expect(pollContent).toEqual("4hello");
      });

      it("sends and receives a payload containing several plain text packets", async () => {
        const sid = await initLongPollingSession();

        const pushResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
          {
            method: "post",
            body: "4test1\x1e4test2\x1e4test3",
          },
        );

        expect(pushResponse.status).toEqual(200);

        const postContent = await pushResponse.text();

        expect(postContent).toEqual("ok");

        const pollResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse.status).toEqual(200);

        const pollContent = await pollResponse.text();

        expect(pollContent).toEqual("4test1\x1e4test2\x1e4test3");
      });

      it("sends and receives a payload containing plain text and binary packets", async () => {
        const sid = await initLongPollingSession();

        const pushResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
          {
            method: "post",
            body: "4hello\x1ebAQIDBA==",
          },
        );

        expect(pushResponse.status).toEqual(200);

        const postContent = await pushResponse.text();

        expect(postContent).toEqual("ok");

        const pollResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse.status).toEqual(200);

        const pollContent = await pollResponse.text();

        expect(pollContent).toEqual("4hello\x1ebAQIDBA==");
      });

      it("closes the session upon invalid packet format", async () => {
        const sid = await initLongPollingSession();

        try {
          const pushResponse = await fetch(
            `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
            {
              method: "post",
              body: "abc",
            },
          );

          expect(pushResponse.status).toEqual(400);
        } catch (e) {
          // node-fetch throws when the request is closed abnormally
        }

        const pollResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse.status).toEqual(400);
      });

      it("closes the session upon duplicate poll requests", async () => {
        const sid = await initLongPollingSession();

        const pollResponses = await Promise.all([
          fetch(`${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`),
          sleep(5).then(() =>
            fetch(
              `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}&t=burst`,
            ),
          ),
        ]);

        expect(pollResponses[0].status).toEqual(200);

        const content = await pollResponses[0].text();

        expect(content).toEqual("1");

        // the Node.js implementation uses HTTP 500 (Internal Server Error), but HTTP 400 seems more suitable
        expect(pollResponses[1].status).toEqual(400);

        const pollResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse.status).toEqual(400);
      });

      it("closes the session upon cancelled polling request", async () => {
        const sid = await initLongPollingSession();
        const controller = new AbortController();

        fetch(`${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`, {
          signal: controller.signal,
        }).catch(() => {});

        await sleep(5);

        controller.abort();

        const pollResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse.status).toEqual(400);
      });
    });

    describe("WebSocket", () => {
      it("sends and receives a plain text packet", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
        );

        await waitFor(socket, "open");

        await waitFor(socket, "message"); // handshake

        socket.send("4hello");

        const { data } = await waitFor(socket, "message");

        expect(data).toEqual("4hello");

        socket.close();
      });

      it("sends and receives a binary packet", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
        );
        socket.binaryType = "arraybuffer";

        await waitFor(socket, "message"); // handshake

        socket.send(Uint8Array.from([1, 2, 3, 4]));

        const { data } = await waitFor(socket, "message");

        expect(data).toEqual(Uint8Array.from([1, 2, 3, 4]).buffer);

        socket.close();
      });

      it("closes the session upon invalid packet format", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
        );

        await waitFor(socket, "message"); // handshake

        socket.send("abc");

        await waitFor(socket, "close");

        socket.close();
      });
    });
  });

  describe("heartbeat", function () {
    describe("HTTP long-polling", () => {
      it("sends ping/pong packets", async () => {
        const sid = await initLongPollingSession();

        for (let i = 0; i < 3; i++) {
          const pollResponse = await fetch(
            `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
          );

          expect(pollResponse.status).toEqual(200);

          const pollContent = await pollResponse.text();

          expect(pollContent).toEqual("2");

          const pushResponse = await fetch(
            `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
            {
              method: "post",
              body: "3",
            },
          );

          expect(pushResponse.status).toEqual(200);
        }
      });

      it("closes the session upon ping timeout", async () => {
        const sid = await initLongPollingSession();

        await sleep(PING_INTERVAL + PING_TIMEOUT + 10);

        const pollResponse = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse.status).toEqual(400);
      });
    });

    describe("WebSocket", () => {
      it("sends ping/pong packets", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
        );

        await waitFor(socket, "message"); // handshake

        for (let i = 0; i < 3; i++) {
          const { data } = await waitFor(socket, "message");

          expect(data).toEqual("2");

          socket.send("3");
        }

        socket.close();
      });

      it("closes the session upon ping timeout", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
        );

        await waitFor(socket, "close"); // handshake
      });
    });
  });

  describe("close", () => {
    describe("HTTP long-polling", () => {
      it("forcefully closes the session", async () => {
        const sid = await initLongPollingSession();

        const [pollResponse] = await Promise.all([
          fetch(`${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`),
          fetch(`${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`, {
            method: "post",
            body: "1",
          }),
        ]);

        expect(pollResponse.status).toEqual(200);

        const pullContent = await pollResponse.text();

        expect(pullContent).toEqual("6");

        const pollResponse2 = await fetch(
          `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
        );

        expect(pollResponse2.status).toEqual(400);
      });
    });

    describe("WebSocket", () => {
      it("forcefully closes the session", async () => {
        const socket = createWebSocket(
          `${WS_URL}/engine.io/?EIO=4&transport=websocket`,
        );

        await waitFor(socket, "message"); // handshake

        socket.send("1");

        await waitFor(socket, "close");
      });
    });
  });

  describe("upgrade", () => {
    it("successfully upgrades from HTTP long-polling to WebSocket", async () => {
      const sid = await initLongPollingSession();

      const socket = createWebSocket(
        `${WS_URL}/engine.io/?EIO=4&transport=websocket&sid=${sid}`,
      );

      await waitFor(socket, "open");

      // send probe
      socket.send("2probe");

      const probeResponse = await waitFor(socket, "message");

      expect(probeResponse.data).toEqual("3probe");

      const pollResponse = await fetch(
        `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
      );

      expect(pollResponse.status).toEqual(200);

      const pollContent = await pollResponse.text();

      expect(pollContent).toEqual("6"); // "noop" packet to cleanly end the HTTP long-polling request

      // complete upgrade
      socket.send("5");

      socket.send("4hello");

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual("4hello");
    });

    it("ignores HTTP requests with same sid after upgrade", async () => {
      const sid = await initLongPollingSession();

      const socket = createWebSocket(
        `${WS_URL}/engine.io/?EIO=4&transport=websocket&sid=${sid}`,
      );

      await waitFor(socket, "open");
      socket.send("2probe");
      await waitFor(socket, "message"); // "3probe"
      socket.send("5");

      const pollResponse = await fetch(
        `${URL}/engine.io/?EIO=4&transport=polling&sid=${sid}`,
      );

      expect(pollResponse.status).toEqual(400);

      socket.send("4hello");

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual("4hello");
    });

    it("ignores WebSocket connection with same sid after upgrade", async () => {
      const sid = await initLongPollingSession();

      const socket = createWebSocket(
        `${WS_URL}/engine.io/?EIO=4&transport=websocket&sid=${sid}`,
      );

      await waitFor(socket, "open");
      socket.send("2probe");
      await waitFor(socket, "message"); // "3probe"
      socket.send("5");

      const socket2 = createWebSocket(
        `${WS_URL}/engine.io/?EIO=4&transport=websocket&sid=${sid}`,
      );

      await waitFor(socket2, "close");

      socket.send("4hello");

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual("4hello");
    });
  });
});
