export type AguiEventBase = {
  type: string;
  timestamp?: number;
  rawEvent?: unknown;
};

export type AguiClientEvent =
  | {
      type: "CLIENT_CONNECTED";
      timestamp: number;
    }
  | {
      type: "CLIENT_ERROR";
      message: string;
      timestamp: number;
    };

export type AguiAnyEvent = AguiEventBase | AguiClientEvent;
