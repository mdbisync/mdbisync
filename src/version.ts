import packageJson from "../package.json" with { type: "json" };

/** The project's repository: the action, the pre-commit hooks and the docs. */
export const PROJECT_URL = "https://github.com/mdbisync/mdbisync";

declare const __MDBISYNC_RELEASE_VERSION__: string | undefined;

export const VERSION: string = typeof __MDBISYNC_RELEASE_VERSION__ === "string"
  ? __MDBISYNC_RELEASE_VERSION__ : packageJson.version;
