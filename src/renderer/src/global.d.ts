import type { EngineEventPayload, PiGuiApi } from "../../shared/ipc-contract.ts";

declare global {
  interface Window {
    piGui: PiGuiApi;
  }
}

declare module "*.css";