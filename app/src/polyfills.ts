// stellar-sdk expects Node's Buffer. Imported first from main.tsx so it is
// in place before any module that touches the SDK is evaluated.
import { Buffer } from "buffer";

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
