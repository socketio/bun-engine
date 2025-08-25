import { Transport } from "../transport";
import { type Packet, Parser } from "../parser";
import { debuglog } from "node:util";

const debug = debuglog("engine.io:polling");

export class Polling extends Transport {
  private pollingPromise?: {
    resolve: (res: Response) => void;
    reject: () => void;
    responseHeaders: Headers;
  };

  public get name() {
    return "polling";
  }

  public get upgradesTo(): string[] {
    return ["websocket"];
  }

  public onRequest(req: Request, responseHeaders: Headers): Promise<Response> {
    if (req.method === "GET") {
      return this.onPollRequest(req, responseHeaders);
    } else if (req.method === "POST") {
      return this.onDataRequest(req, responseHeaders);
    }
    return Promise.resolve(
      new Response(null, { status: 400, headers: responseHeaders }),
    );
  }

  /**
   * The client sends a long-polling request awaiting the server to send data.
   *
   * @param req
   * @param responseHeaders
   * @private
   */
  private onPollRequest(
    req: Request,
    responseHeaders: Headers,
  ): Promise<Response> {
    if (this.pollingPromise) {
      debug("request overlap");
      this.onError("overlap from client");
      return Promise.resolve(
        new Response(null, { status: 400, headers: responseHeaders }),
      );
    }

    debug("new polling request");

    req.signal.addEventListener("abort", () => {
      this.onError("polling request aborted");
    });

    return new Promise<Response>((resolve, reject) => {
      this.pollingPromise = { resolve, reject, responseHeaders };

      debug("transport is now writable");
      this.writable = true;
      this.emitReserved("drain");
    });
  }

  /**
   * The client sends a request with data.
   *
   * @param req
   * @param responseHeaders
   */
  private async onDataRequest(
    req: Request,
    responseHeaders: Headers,
  ): Promise<Response> {
    debug("new data request");

    req.signal.addEventListener("abort", () => {
      this.onError("data request aborted");
    });

    const data = await req.text();

    if (data.length > this.opts.maxHttpBufferSize) {
      this.onError("payload too large");
      return Promise.resolve(
        new Response(null, { status: 413, headers: responseHeaders }),
      );
    }

    const packets = Parser.decodePayload(data);

    debug(`decoded ${packets.length} packet(s)`);

    for (const packet of packets) {
      this.onPacket(packet);
    }

    return Promise.resolve(
      new Response("ok", {
        status: 200,
        headers: responseHeaders,
      }),
    );
  }

  public send(packets: Packet[]) {
    this.writable = false;
    Parser.encodePayload(packets, (data: string) => this.write(data));
  }

  /**
   * Writes data as response to long-polling request
   *
   * @param data
   * @private
   */
  private write(data: string) {
    debug(`writing ${data}`);

    if (!this.pollingPromise) {
      return;
    }

    const headers = this.pollingPromise.responseHeaders;
    headers.set("Content-Type", "text/plain; charset=UTF-8");

    this.pollingPromise.resolve(
      new Response(data, {
        status: 200,
        headers,
      }),
    );

    this.pollingPromise = undefined;
  }

  protected doClose() {
    if (this.writable) {
      debug("transport writable - closing right away");
      // if we have received a "close" packet from the client, then we can just send a "noop" packet back
      this.send([{ type: this.readyState === "closing" ? "close" : "noop" }]);
    }

    this.onClose();
  }
}
