import { randomBytes } from "node:crypto";

export function generateId(): string {
  return randomBytes(15).toString("base64url");
}
