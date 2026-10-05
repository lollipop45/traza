import "server-only";
import { readCanvasConfig } from "./env";
import { readCanvasOverview, type CanvasOverview } from "./read";

// Server-only entry point to Canvas. `server-only` makes any accidental import from a Client
// Component a build error, so the token-reading code can never reach the browser.

/** Identity and active courses of the configured Canvas account. Never throws. */
export async function getCanvasOverview(): Promise<CanvasOverview> {
  return readCanvasOverview(readCanvasConfig());
}
