export type RuntimeMode = "development" | "test" | "production";

export type BrowserConfig = {
  mode: RuntimeMode;
  appName: string;
  apiBaseUrl: string;
  aguiBaseUrl: string;
};

export type NodeConfig = {
  mode: RuntimeMode;

  server: {
    host: string;
    port: number;
    corsOrigin: string;
  };

  agent: {
    maxAgentLoops: number;
    maxToolCalls: number;
    maxContextTokens: number;
  };
};
