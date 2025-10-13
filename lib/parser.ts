const SEPARATOR = String.fromCharCode(30); // see https://en.wikipedia.org/wiki/Delimiter#ASCII_delimited_text

export type PacketType =
  | "open"
  | "close"
  | "ping"
  | "pong"
  | "message"
  | "upgrade"
  | "noop"
  | "error";

export type RawData = string | Buffer;

export interface Packet {
  type: PacketType;
  data?: RawData;
}

const PACKET_TYPES = new Map<PacketType, string>();
const PACKET_TYPES_REVERSE = new Map<string, PacketType>();

(
  [
    "open",
    "close",
    "ping",
    "pong",
    "message",
    "upgrade",
    "noop",
  ] as PacketType[]
).forEach((type, index) => {
  PACKET_TYPES.set(type, "" + index);
  PACKET_TYPES_REVERSE.set("" + index, type);
});

const ERROR_PACKET: Packet = { type: "error", data: "parser error" };

type BinaryType = "arraybuffer" | "blob";

export const Parser = {
  encodePacket({ type, data }: Packet, supportsBinary: boolean): RawData {
    if (Buffer.isBuffer(data)) {
      return supportsBinary ? data : "b" + data.toString("base64");
    } else {
      return PACKET_TYPES.get(type) + (data || "");
    }
  },

  decodePacket(encodedPacket: RawData, _binaryType?: BinaryType): Packet {
    if (typeof encodedPacket !== "string") {
      return {
        type: "message",
        data: encodedPacket,
      };
    }
    const typeChar = encodedPacket.charAt(0);
    if (typeChar === "b") {
      const buffer = Buffer.from(encodedPacket.substring(1), "base64");
      return {
        type: "message",
        data: buffer,
      };
    }
    if (!PACKET_TYPES_REVERSE.has(typeChar)) {
      return ERROR_PACKET;
    }
    const type = PACKET_TYPES_REVERSE.get(typeChar)!;
    return encodedPacket.length > 1
      ? {
          type,
          data: encodedPacket.substring(1),
        }
      : {
          type,
        };
  },

  encodePayload(packets: Packet[]) {
    const encodedPackets = [];

    for (const packet of packets) {
      encodedPackets.push(this.encodePacket(packet, false));
    }

    return encodedPackets.join(SEPARATOR);
  },

  decodePayload(encodedPayload: string, binaryType?: BinaryType): Packet[] {
    const encodedPackets = encodedPayload.split(SEPARATOR);
    const packets = [];
    for (let i = 0; i < encodedPackets.length; i++) {
      const decodedPacket = this.decodePacket(encodedPackets[i]!, binaryType);
      packets.push(decodedPacket);
      if (decodedPacket.type === "error") {
        break;
      }
    }
    return packets;
  },
};
