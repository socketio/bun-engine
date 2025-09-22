import { EventEmitter } from "./event-emitter";
import { Socket } from "./socket";
import { Polling } from "./transports/polling";
import { WS, type BunWebSocket } from "./transports/websocket";
import { addCorsHeaders, type CorsOptions } from "./cors";
import { Transport } from "./transport";
import { generateId } from "./util";
import type { RawData } from "./parser";
import { debuglog } from "node:util";

const debug = debuglog("engine.io");

const TRANSPORTS = ["polling", "websocket"];

export interface ServerOptions {
  /**
   * Name of the request path to handle
   * @default "/engine.io/"
   */
  path: string;
  /**
   * Duration in milliseconds without a pong packet to consider the connection closed
   * @default 20000
   */
  pingTimeout: number;
  /**
   * Duration in milliseconds before sending a new ping packet
   * @default 25000
   */
  pingInterval: number;
  /**
   * Duration in milliseconds before an uncompleted transport upgrade is cancelled
   * @default 10000
   */
  upgradeTimeout: number;
  /**
   * Maximum size in bytes or number of characters a message can be, before closing the session (to avoid DoS).
   * @default 1e6 (1 MB)
   */
  maxHttpBufferSize: number;
  /**
   * A function that receives a given handshake or upgrade request as its first parameter,
   * and can decide whether to continue or not.
   */
  allowRequest?: (req: Request, server: Bun.Server) => Promise<void>;
  /**
   * The options related to Cross-Origin Resource Sharing (CORS)
   */
  cors?: CorsOptions;
  /**
   * A function that allows to edit the response headers of the handshake request
   */
  editHandshakeHeaders?: (
    responseHeaders: Headers,
    req: Request,
    server: Bun.Server,
  ) => void | Promise<void>;
  /**
   * A function that allows to edit the response headers of all requests
   */
  editResponseHeaders?: (
    responseHeaders: Headers,
    req: Request,
    server: Bun.Server,
  ) => void | Promise<void>;
}

interface ConnectionError {
  req: Request;
  code: number;
  message: string;
  context: Record<string, unknown>;
}

interface ServerReservedEvents {
  connection: (socket: Socket, request: Request, server: Bun.Server) => void;
  connection_error: (err: ConnectionError) => void;
}

const enum ERROR_CODES {
  UNKNOWN_TRANSPORT = 0,
  UNKNOWN_SID,
  BAD_HANDSHAKE_METHOD,
  BAD_REQUEST,
  FORBIDDEN,
  UNSUPPORTED_PROTOCOL_VERSION,
}

const ERROR_MESSAGES = new Map<ERROR_CODES, string>([
  [ERROR_CODES.UNKNOWN_TRANSPORT, "Transport unknown"],
  [ERROR_CODES.UNKNOWN_SID, "Session ID unknown"],
  [ERROR_CODES.BAD_HANDSHAKE_METHOD, "Bad handshake method"],
  [ERROR_CODES.BAD_REQUEST, "Bad request"],
  [ERROR_CODES.FORBIDDEN, "Forbidden"],
  [ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version"],
]);

export class Server extends EventEmitter<
  Record<never, never>,
  Record<never, never>,
  ServerReservedEvents
> {
  public readonly opts: ServerOptions;

  private clients: Map<string, Socket> = new Map();

  constructor(opts: Partial<ServerOptions> = {}) {
    super();

    this.opts = Object.assign(
      {
        path: "/engine.io/",
        pingTimeout: 20000,
        pingInterval: 25000,
        upgradeTimeout: 10000,
        maxHttpBufferSize: 1e6,
      },
      opts,
    );
  }

  /**
   * Handles an HTTP request.
   *
   * @param req
   * @param server
   */
  public async handleRequest(
    req: Request,
    server: Bun.Server,
  ): Promise<Response> {
    const url = new URL(req.url);

    debug(`handling ${req.method} ${req.url}`);

    const responseHeaders = new Headers();
    if (this.opts.cors) {
      addCorsHeaders(responseHeaders, this.opts.cors, req);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: responseHeaders });
      }
    }

    if (this.opts.editResponseHeaders) {
      await this.opts.editResponseHeaders(responseHeaders, req, server);
    }

    try {
      await this.verify(req, url);
    } catch (err) {
      const { code, context } = err as {
        code: ERROR_CODES;
        context: Record<string, unknown>;
      };
      const message = ERROR_MESSAGES.get(code)!;
      this.emitReserved("connection_error", {
        req,
        code,
        message,
        context,
      });
      const body = JSON.stringify({
        code,
        message,
      });
      responseHeaders.set("Content-Type", "application/json");
      return new Response(body, {
        status: 400,
        headers: responseHeaders,
      });
    }

    if (this.opts.allowRequest) {
      try {
        await this.opts.allowRequest(req, server);
      } catch (reason) {
        this.emitReserved("connection_error", {
          req,
          code: ERROR_CODES.FORBIDDEN,
          message: ERROR_MESSAGES.get(ERROR_CODES.FORBIDDEN)!,
          context: {
            message: reason,
          },
        });
        const body = JSON.stringify({
          code: ERROR_CODES.FORBIDDEN,
          message: reason,
        });
        responseHeaders.set("Content-Type", "application/json");
        return new Response(body, {
          status: 403,
          headers: responseHeaders,
        });
      }
    }

    const sid = url.searchParams.get("sid");
    if (sid) {
      // the client must exist since we have checked it in the verify method
      const socket = this.clients.get(sid)!;

      if (req.headers.has("upgrade")) {
        const transport = new WS(this.opts);

        const isSuccess = server.upgrade(req, {
          headers: responseHeaders,
          data: {
            transport,
          },
        });

        debug(`upgrade was successful: ${isSuccess}`);

        if (!isSuccess) {
          return new Response(null, { status: 500 });
        }

        socket._maybeUpgrade(transport);
        return new Response(null);
      }

      debug("setting new request for existing socket");

      return (socket.transport as Polling).onRequest(req, responseHeaders);
    } else {
      return this.handshake(req, server, responseHeaders);
    }
  }

  public onWebSocketOpen(ws: BunWebSocket) {
    debug("on ws open");
    ws.data.transport.onOpen(ws);
  }

  public onWebSocketMessage(ws: BunWebSocket, message: RawData) {
    debug("on ws message");
    ws.data.transport.onMessage(message);
  }

  public onWebSocketClose(ws: BunWebSocket, code: number, message: string) {
    debug("on ws close");
    ws.data.transport.onCloseEvent(code, message);
  }

  /**
   * Verifies a request.
   *
   * @param req
   * @param url
   * @private
   */
  private verify(req: Request, url: URL): Promise<void> {
    const transport = url.searchParams.get("transport") || "";
    if (!TRANSPORTS.includes(transport)) {
      debug(`unknown transport "${transport}"`);
      return Promise.reject({
        code: ERROR_CODES.UNKNOWN_TRANSPORT,
        context: {
          transport,
        },
      });
    }

    const sid = url.searchParams.get("sid");
    if (sid) {
      const client = this.clients.get(sid);
      if (!client) {
        debug(`unknown client with sid ${sid}`);
        return Promise.reject({
          code: ERROR_CODES.UNKNOWN_SID,
          context: {
            sid,
          },
        });
      }
      const previousTransport = client.transport.name;
      if (previousTransport === "websocket") {
        debug("unexpected transport without upgrade");
        return Promise.reject({
          code: ERROR_CODES.BAD_REQUEST,
          context: {
            name: "TRANSPORT_MISMATCH",
            transport,
            previousTransport,
          },
        });
      }
    } else {
      // handshake is GET only
      if (req.method !== "GET") {
        return Promise.reject({
          code: ERROR_CODES.BAD_HANDSHAKE_METHOD,
          context: {
            method: req.method,
          },
        });
      }

      const protocol = url.searchParams.get("EIO") === "4" ? 4 : 3; // 3rd revision by default
      if (protocol === 3) {
        return Promise.reject({
          code: ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION,
          context: {
            protocol,
          },
        });
      }
    }

    return Promise.resolve();
  }

  /**
   * Handshakes a new client.
   *
   * @param req
   * @param server
   * @param responseHeaders
   * @private
   */
  private async handshake(
    req: Request,
    server: Bun.Server,
    responseHeaders: Headers,
  ): Promise<Response> {
    const id = generateId();

    if (this.opts.editHandshakeHeaders) {
      await this.opts.editHandshakeHeaders(responseHeaders, req, server);
    }

    let isUpgrade = req.headers.has("upgrade");
    let transport: Transport;
    if (isUpgrade) {
      transport = new WS(this.opts);

      const isSuccess = server.upgrade(req, {
        headers: responseHeaders,
        data: {
          transport,
        },
      });

      if (!isSuccess) {
        return new Response(null, { status: 500 });
      }
    } else {
      transport = new Polling(this.opts);
    }

    debug(`new socket ${id}`);

    const socket = new Socket(id, this.opts, transport, req);
    this.clients.set(id, socket);

    socket.once("close", (reason) => {
      debug(`socket ${id} closed due to ${reason}`);
      this.clients.delete(id);
    });

    if (isUpgrade) {
      this.emitReserved("connection", socket, req, server);
      return new Response(null);
    }

    const promise = (transport as Polling).onRequest(req, responseHeaders);

    this.emitReserved("connection", socket, req, server);

    return promise;
  }

  /**
   * Closes all clients.
   */
  public close() {
    debug("closing all open clients");
    this.clients.forEach((client) => client.close());
  }

  /**
   * Creates a request handler.
   *
   * @example
   * Bun.serve({
   *   port: 3000,
   *   ...engine.handler()
   * });
   *
   * // expanded
   * Bun.serve({
   *   port: 3000,
   *
   *   fetch(req, server) {
   *     return engine.handleRequest(req, server);
   *   },
   *
   *   websocket: {
   *     open(ws: BunWebSocket) {
   *       engine.onWebSocketOpen(ws);
   *     },
   *
   *     message(ws: BunWebSocket, message: RawData) {
   *       engine.onWebSocketMessage(ws, message);
   *     },
   *
   *     close(ws: BunWebSocket, code: number, message: string) {
   *       engine.onWebSocketClose(ws, code, message);
   *     },
   *   },
   * });
   */
  public handler() {
    const idleTimeoutInSeconds = Math.ceil((2 * this.opts.pingInterval) / 1000);

    return {
      fetch: (req: Request, server: Bun.Server) => {
        const url = new URL(req.url);

        if (url.pathname === this.opts.path) {
          return this.handleRequest(req, server);
        } else {
          return new Response(null, { status: 404 });
        }
      },

      websocket: {
        open: (ws: BunWebSocket) => {
          this.onWebSocketOpen(ws);
        },
        message: (ws: BunWebSocket, message: RawData) => {
          this.onWebSocketMessage(ws, message);
        },
        close: (ws: BunWebSocket, code: number, message: string) => {
          this.onWebSocketClose(ws, code, message);
        },
        maxPayloadLength: this.opts.maxHttpBufferSize,
      },

      idleTimeout: idleTimeoutInSeconds,
      maxRequestBodySize: this.opts.maxHttpBufferSize,
    };
  }
}
