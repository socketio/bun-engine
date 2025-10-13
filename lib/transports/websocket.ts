import { Transport } from "../transport";
import { type Packet, Parser, type RawData } from "../parser";
import { debuglog } from "node:util";

const debug = debuglog("engine.io:websocket");

export type WebSocketData = {
  transport: WS;
};

export type BunWebSocket = Bun.ServerWebSocket<WebSocketData>;

export class WS extends Transport {
  private socket?: BunWebSocket;

  public get name() {
    return "websocket";
  }

  public get upgradesTo(): string[] {
    return [];
  }

  public send(packets: Packet[]) {
    for (const packet of packets) {
      const data = Parser.encodePacket(packet, true);
      if (this.writable && this.socket?.readyState === WebSocket.OPEN) {
        // TODO use ws.cork() once https://github.com/oven-sh/bun/issues/21588 is resolved
        this.socket.send(data);
      }
    }
  }

  protected doClose() {
    this.socket?.close();
  }

  public onOpen(socket: BunWebSocket) {
    debug("on open");
    this.socket = socket;
    this.writable = true;
  }

  public onMessage(message: RawData) {
    debug("on message");
    this.onPacket(Parser.decodePacket(message));
  }

  public onCloseEvent(_code: number, _message: string) {
    debug("on close");
    this.onClose();
  }
}
