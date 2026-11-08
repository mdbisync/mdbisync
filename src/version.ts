import packageJson from "../package.json" with { type: "json" };

declare const __MDBISYNC_RELEASE_VERSION__: string | undefined;

export const VERSION: string = typeof __MDBISYNC_RELEASE_VERSION__ === "string"
  ? __MDBISYNC_RELEASE_VERSION__ : packageJson.version;
