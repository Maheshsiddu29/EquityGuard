/**
 * Browser implementation for the Node `Buffer` identifier used by the frozen
 * guard-client while decoding RPC base64 data and composing byte sequences.
 * esbuild injects this binding wherever the bundled dependency references
 * `Buffer`; the economic-state decoding itself remains in guard-client.
 */
import { Buffer } from "buffer";

export { Buffer };
