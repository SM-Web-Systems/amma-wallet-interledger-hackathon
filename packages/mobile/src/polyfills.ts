import "react-native-url-polyfill/auto";
import "react-native-get-random-values";
import { Buffer } from "buffer";
import { ensureProcess } from "./process-polyfill";

global.Buffer = global.Buffer || Buffer;

// Polyfill TextEncoder/TextDecoder
if (typeof global.TextEncoder === "undefined") {
  const { TextEncoder, TextDecoder } = require("text-encoding");
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}

// Polyfill process.env and process.version
ensureProcess(global);
