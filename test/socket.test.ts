import { describe, it, expect, beforeAll } from "bun:test";
import { Server as Engine } from "../lib";
import { Server } from "socket.io";
import { createWebSocket, waitFor, waitForPackets } from "./util";

const URL = "http://localhost:3001";
const WS_URL = URL.replace("http", "ws");

const PING_INTERVAL = 300;
const PING_TIMEOUT = 200;

async function initSocketIOConnection() {
  const socket = createWebSocket(
    `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
  );
  socket.binaryType = "arraybuffer";

  await waitFor(socket, "message"); // Engine.IO handshake

  socket.send("40");

  await waitFor(socket, "message"); // Socket.IO handshake
  await waitFor(socket, "message"); // "auth" packet

  return socket;
}

function setup() {
  const io = new Server();

  const engine = new Engine({
    path: "/socket.io/",
    pingInterval: PING_INTERVAL,
    pingTimeout: PING_TIMEOUT,
  });

  io.bind(engine);

  io.on("connection", (socket) => {
    expect(socket.handshake.headers).toContainKey("host");
    expect(socket.handshake.query.EIO).toEqual("4");
    expect(socket.handshake.url).toStartWith(
      "http://localhost:3001/socket.io/?EIO=4",
    );

    socket.emit("auth", socket.handshake.auth);

    socket.on("message", (...args) => {
      socket.emit.apply(socket, ["message-back", ...args]);
    });

    socket.on("message-with-ack", (...args) => {
      const ack = args.pop();
      ack(...args);
    });
  });

  io.of("/custom").on("connection", (socket) => {
    socket.emit("auth", socket.handshake.auth);
  });

  Bun.serve({
    port: 3001,
    ...engine.handler(),
  });
}

// imported from https://github.com/socketio/socket.io/tree/main/docs/socket.io-protocol/v5-test-suite
describe("Socket.IO protocol", () => {
  beforeAll(() => setup());

  describe("connect", () => {
    it("should allow connection to the main namespace", async () => {
      const socket = createWebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send("40");

      const { data } = await waitFor(socket, "message");

      expect(data).toStartWith("40");

      const handshake = JSON.parse(data.substring(2));

      expect(handshake).toContainAllKeys(["sid"]);
      expect(handshake.sid).toBeString();

      const authPacket = await waitFor(socket, "message");

      expect(authPacket.data).toEqual('42["auth",{}]');
    });

    it("should allow connection to the main namespace with a payload", async () => {
      const socket = createWebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send('40{"token":"123"}');

      const { data } = await waitFor(socket, "message");

      expect(data).toStartWith("40");

      const handshake = JSON.parse(data.substring(2));

      expect(handshake).toContainAllKeys(["sid"]);
      expect(handshake.sid).toBeString();

      const authPacket = await waitFor(socket, "message");

      expect(authPacket.data).toEqual('42["auth",{"token":"123"}]');
    });

    it("should allow connection to a custom namespace", async () => {
      const socket = createWebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send("40/custom,");

      const { data } = await waitFor(socket, "message");

      expect(data).toStartWith("40/custom,");

      const handshake = JSON.parse(data.substring(10));

      expect(handshake).toContainAllKeys(["sid"]);
      expect(handshake.sid).toBeString();

      const authPacket = await waitFor(socket, "message");

      expect(authPacket.data).toEqual('42/custom,["auth",{}]');
    });

    it("should allow connection to a custom namespace with a payload", async () => {
      const socket = createWebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send('40/custom,{"token":"abc"}');

      const { data } = await waitFor(socket, "message");

      expect(data).toStartWith("40/custom,");

      const handshake = JSON.parse(data.substring(10));

      expect(handshake).toContainAllKeys(["sid"]);
      expect(handshake.sid).toBeString();

      const authPacket = await waitFor(socket, "message");

      expect(authPacket.data).toEqual('42/custom,["auth",{"token":"abc"}]');
    });

    it("should disallow connection to an unknown namespace", async () => {
      const socket = createWebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send("40/random");

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual('44/random,{"message":"Invalid namespace"}');
    });

    it("should disallow connection with an invalid handshake", async () => {
      const socket = createWebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send("4abc");

      await waitFor(socket, "close");
    });

    it("should close the connection if no handshake is received", async () => {
      const socket = createWebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
      );

      await waitFor(socket, "close");
    });
  });

  describe("disconnect", () => {
    it("should disconnect from the main namespace", async () => {
      const socket = await initSocketIOConnection();

      socket.send("41");

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual("2");
    });

    it("should connect then disconnect from a custom namespace", async () => {
      const socket = await initSocketIOConnection();

      await waitFor(socket, "message"); // ping

      socket.send("40/custom");

      await waitFor(socket, "message"); // Socket.IO handshake
      await waitFor(socket, "message"); // auth packet

      socket.send("41/custom");
      socket.send('42["message","message to main namespace"]');

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual('42["message-back","message to main namespace"]');
    });
  });

  describe("message", () => {
    it("should send a plain-text packet", async () => {
      const socket = await initSocketIOConnection();

      socket.send('42["message",1,"2",{"3":[true]}]');

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual('42["message-back",1,"2",{"3":[true]}]');
    });

    it("should send a packet with binary attachments", async () => {
      const socket = await initSocketIOConnection();

      socket.send(
        '452-["message",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]',
      );
      socket.send(Uint8Array.from([1, 2, 3]));
      socket.send(Uint8Array.from([4, 5, 6]));

      const packets = await waitForPackets(socket, 3);

      expect(packets[0]).toEqual(
        '452-["message-back",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]',
      );
      expect(packets[1]).toEqual(
        Uint8Array.from([1, 2, 3]).buffer as ArrayBuffer,
      );
      expect(packets[2]).toEqual(
        Uint8Array.from([4, 5, 6]).buffer as ArrayBuffer,
      );

      socket.close();
    });

    it("should send a plain-text packet with an ack", async () => {
      const socket = await initSocketIOConnection();

      socket.send('42456["message-with-ack",1,"2",{"3":[false]}]');

      const { data } = await waitFor(socket, "message");

      expect(data).toEqual('43456[1,"2",{"3":[false]}]');
    });

    it("should send a packet with binary attachments and an ack", async () => {
      const socket = await initSocketIOConnection();

      socket.send(
        '452-789["message-with-ack",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]',
      );
      socket.send(Uint8Array.from([1, 2, 3]));
      socket.send(Uint8Array.from([4, 5, 6]));

      const packets = await waitForPackets(socket, 3);

      expect(packets[0]).toEqual(
        '462-789[{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]',
      );
      expect(packets[1]).toEqual(
        Uint8Array.from([1, 2, 3]).buffer as ArrayBuffer,
      );
      expect(packets[2]).toEqual(
        Uint8Array.from([4, 5, 6]).buffer as ArrayBuffer,
      );

      socket.close();
    });

    it("should close the connection upon invalid format (unknown packet type)", async () => {
      const socket = await initSocketIOConnection();

      socket.send("4abc");

      await waitFor(socket, "close");
    });

    it("should close the connection upon invalid format (invalid payload format)", async () => {
      const socket = await initSocketIOConnection();

      socket.send("42{}");

      await waitFor(socket, "close");
    });

    it("should close the connection upon invalid format (invalid ack id)", async () => {
      const socket = await initSocketIOConnection();

      socket.send('42abc["message-with-ack",1,"2",{"3":[false]}]');

      await waitFor(socket, "close");
    });
  });
});
