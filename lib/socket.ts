import { EventEmitter } from "./event-emitter";
import { type Packet, type PacketType, type RawData } from "./parser";
import { Transport, TransportError } from "./transport";
import { type ServerOptions } from "./server";
import { debuglog } from "node:util";

const debug = debuglog("engine.io:socket");

type ReadyState = "opening" | "open" | "closing" | "closed";

type UpgradeState = "not_upgraded" | "upgrading" | "upgraded";

// this is the format expected by the `socket.io` library
// see https://github.com/socketio/socket.io/blob/cf6816afcff25c227b14ae6981e421bcad5af331/packages/socket.io/lib/socket.ts#L201-L215
export interface HandshakeRequestReference {
  url: string;
  headers: Record<string, string>;
  _query: Record<string, string>;
  connection: {
    encrypted: boolean;
  };
}

export type CloseReason =
  | "transport error"
  | "transport close"
  | "forced close"
  | "ping timeout"
  | "parse error";

interface SocketEvents {
  open: () => void;
  packet: (packet: Packet) => void;
  packetCreate: (packet: Packet) => void;
  data: (data: RawData) => void;
  flush: (writeBuffer: Packet[]) => void;
  drain: () => void;
  heartbeat: () => void;
  upgrading: (transport: Transport) => void;
  upgrade: (transport: Transport) => void;
  close: (reason: CloseReason) => void;
}

const FAST_UPGRADE_INTERVAL_MS = 100;

export class Socket extends EventEmitter<
  Record<never, never>,
  Record<never, never>,
  SocketEvents
> {
  public readonly id: string;
  public readyState: ReadyState = "opening";
  public transport: Transport;
  public readonly request: HandshakeRequestReference;

  private readonly opts: ServerOptions;
  private upgradeState: UpgradeState = "not_upgraded";
  private writeBuffer: Packet[] = [];
  /*
   * Note: using a single timer for all sockets seems to result in a higher CPU consumption than using one timer for each socket
   */
  private pingIntervalTimer?: Timer;
  private pingTimeoutTimer?: Timer;

  constructor(
    id: string,
    opts: ServerOptions,
    transport: Transport,
    req: HandshakeRequestReference,
  ) {
    super();

    this.id = id;
    this.opts = opts;

    this.transport = transport;
    this.bindTransport(transport);

    this.request = req;

    this.onOpen();
  }

  /**
   * Called upon transport considered open.
   *
   * @private
   */
  private onOpen() {
    this.readyState = "open";

    this.sendPacket(
      "open",
      JSON.stringify({
        sid: this.id,
        upgrades: this.transport.upgradesTo,
        pingInterval: this.opts.pingInterval,
        pingTimeout: this.opts.pingTimeout,
        maxPayload: this.opts.maxHttpBufferSize,
      }),
    );

    this.emitReserved("open");
    this.schedulePing();
  }

  /**
   * Called upon transport packet.
   *
   * @param packet
   * @private
   */
  private onPacket(packet: Packet) {
    if (this.readyState !== "open") {
      debug("packet received with closed socket");
      return;
    }

    debug(`received packet ${packet.type}`);

    this.emitReserved("packet", packet);

    switch (packet.type) {
      case "pong":
        debug("got pong");

        clearTimeout(this.pingTimeoutTimer);
        this.schedulePing();

        this.emitReserved("heartbeat");
        break;

      case "message":
        this.emitReserved("data", packet.data!);
        break;

      case "error":
      default:
        this.onClose("parse error");
        break;
    }
  }

  /**
   * Called upon transport error.
   *
   * @param err
   * @private
   */
  private onError(err: TransportError) {
    debug(`transport error: ${err.message}`);
    this.onClose("transport error");
  }

  /**
   * Pings client every `pingInterval` and expects response
   * within `pingTimeout` or closes connection.
   *
   * @private
   */
  private schedulePing() {
    if (this.pingTimeoutTimer) {
      this.pingIntervalTimer?.refresh();
      return;
    }
    this.pingIntervalTimer = setTimeout(() => {
      debug(
        `writing ping packet - expecting pong within ${this.opts.pingTimeout} ms`,
      );
      this.sendPacket("ping");
      this.resetPingTimeout();
    }, this.opts.pingInterval);
  }

  /**
   * Resets ping timeout.
   *
   * @private
   */
  private resetPingTimeout() {
    clearTimeout(this.pingTimeoutTimer);
    this.pingTimeoutTimer = setTimeout(() => {
      this.onClose("ping timeout");
    }, this.opts.pingTimeout);
  }

  /**
   * Attaches handlers for the given transport.
   *
   * @param transport
   * @private
   */
  private bindTransport(transport: Transport) {
    this.transport = transport;
    this.transport.once("error", (err) => this.onError(err));
    this.transport.on("packet", (packet) => this.onPacket(packet));
    this.transport.on("drain", () => this.flush());
    this.transport.on("close", () => this.onClose("transport close"));
  }

  /**
   * Upgrades socket to the given transport
   *
   * @param transport
   * @private
   */
  /* private */ _maybeUpgrade(transport: Transport) {
    if (this.upgradeState === "upgrading") {
      debug("transport has already been trying to upgrade");
      return transport.close();
    } else if (this.upgradeState === "upgraded") {
      debug("transport has already been upgraded");
      return transport.close();
    }

    debug("upgrading existing transport");
    this.upgradeState = "upgrading";

    const timeoutId = setTimeout(() => {
      debug("client did not complete upgrade - closing transport");
      transport.close();
    }, this.opts.upgradeTimeout);

    transport.on("close", () => {
      clearInterval(fastUpgradeTimerId);
      transport.off();
    });

    let fastUpgradeTimerId: NodeJS.Timeout;

    // we need to make sure that no packets gets lost during the upgrade, so the client does not cancel the HTTP
    // long-polling request itself, instead the server sends a "noop" packet to cleanly end any ongoing polling request
    const sendNoopPacket = () => {
      if (this.transport.name === "polling" && this.transport.writable) {
        debug("writing a noop packet to polling for fast upgrade");
        this.transport.send([{ type: "noop" }]);
      }
    };

    transport.on("packet", (packet) => {
      if (packet.type === "ping" && packet.data === "probe") {
        debug("got probe ping packet, sending pong");
        transport.send([{ type: "pong", data: "probe" }]);

        sendNoopPacket();
        fastUpgradeTimerId = setInterval(
          sendNoopPacket,
          FAST_UPGRADE_INTERVAL_MS,
        );

        this.emitReserved("upgrading", transport);
      } else if (packet.type === "upgrade" && this.readyState !== "closed") {
        debug("got upgrade packet - upgrading");

        this.upgradeState = "upgraded";

        clearTimeout(timeoutId);
        clearInterval(fastUpgradeTimerId);
        transport.off();
        this.closeTransport();
        this.bindTransport(transport);

        this.emitReserved("upgrade", transport);
        this.flush();
      } else {
        debug("invalid upgrade packet");

        clearTimeout(timeoutId);
        transport.close();
      }
    });
  }

  /**
   * Called upon transport considered closed.
   *
   * @param reason
   * @private
   */
  private onClose(reason: CloseReason) {
    if (this.readyState === "closed") {
      return;
    }
    debug(`socket closed due to ${reason}`);

    this.readyState = "closed";
    clearTimeout(this.pingIntervalTimer);
    clearTimeout(this.pingTimeoutTimer);

    this.closeTransport();
    this.emitReserved("close", reason);
  }

  /**
   * Sends a "message" packet.
   *
   * @param data
   */
  public write(data: RawData): Socket {
    this.sendPacket("message", data);
    return this;
  }

  /**
   * Sends a packet.
   *
   * @param type
   * @param data
   * @private
   */
  private sendPacket(type: PacketType, data?: RawData) {
    if (["closing", "closed"].includes(this.readyState)) {
      return;
    }

    debug(`sending packet ${type} (${data})`);

    const packet: Packet = {
      type,
      data,
    };

    this.emitReserved("packetCreate", packet);

    this.writeBuffer.push(packet);

    this.flush();
  }

  /**
   * Attempts to flush the packets buffer.
   *
   * @private
   */
  private flush() {
    const shouldFlush =
      this.readyState !== "closed" &&
      this.transport.writable &&
      this.writeBuffer.length > 0;

    if (!shouldFlush) {
      return;
    }

    debug(
      `[socket] flushing buffer with ${this.writeBuffer.length} packet(s) to transport`,
    );

    this.emitReserved("flush", this.writeBuffer);

    const buffer = this.writeBuffer;
    this.writeBuffer = [];

    this.transport.send(buffer);
    this.emitReserved("drain");
  }

  /**
   * Closes the socket and underlying transport.
   */
  public close() {
    if (this.readyState !== "open") {
      return;
    }

    this.readyState = "closing";

    const close = () => {
      this.closeTransport();
      this.onClose("forced close");
    };

    if (this.writeBuffer.length) {
      debug(`buffer not empty, waiting for the drain event`);
      this.once("drain", close);
    } else {
      close();
    }
  }

  /**
   * Closes the underlying transport.
   *
   * @private
   */
  private closeTransport() {
    this.transport.off();
    this.transport.close();
  }
}
