// The bundles the build writes to dist/, one per entry point. The release
// ships every one of them: `action.yml` and `package.json` name some, while
// others are run by path from a bundle (the hooks step's script beside the
// action's main). This module needs nothing but Node, so the release's tag
// step can check the tree against it without installing dependencies.

export const ENTRY_POINTS = {
  cli: 'src/cli.ts',
  'action-main': 'src/action/main.ts',
  'action-post': 'src/action/post.ts',
  'action-hooks': 'src/action/hooks.ts',
} as const;

/** Every bundle the release must hold, by its path in the release tree. */
export const RELEASE_BUNDLES: readonly string[] = Object.keys(ENTRY_POINTS).map((name) => `dist/${name}.js`).sort();
