// A run's tree moves the team-zone files below a folder named after the run,
// while project folders keep their corpus paths. A relative link between a
// moved file and an unmoved one then misses the file the corpus links. The
// run tree rewrites such a link to the run-tree path of the same corpus file,
// so the run holds the corpus as designed and leaves out only what the
// corpus means it to leave out.

import { posix } from 'node:path';
import { linkedFile, rewriteDestinations } from './checks.ts';
import type { RunTree } from './corpus.ts';

/**
 * The run tree with every link and image of the given Markdown texts (by
 * corpus path) pointed at its corpus file's place in the run. A link that
 * already reaches that place, or whose target is not in the run, stays as
 * written. Annotation READMEs start from their rewritten text.
 */
export function relinkRunTree(tree: RunTree, texts: ReadonlyMap<string, string>): RunTree {
  const placeOf = new Map([...tree.paths].map(([target, source]) => [source, target]));
  const rewritten = new Map(tree.rewritten);
  for (const [target, source] of tree.paths) {
    const text = rewritten.get(target) ?? texts.get(source);
    if (text === undefined) continue;
    const relinked = rewriteDestinations(text, (destination) => {
      const linked = linkedFile(source, destination.url);
      const place = linked === undefined ? undefined : placeOf.get(linked.path);
      if (place === undefined || linkedFile(target, destination.url)?.path === place) return undefined;
      return destinationTo(text.slice(destination.from, destination.to), target, place);
    });
    if (relinked !== text) rewritten.set(target, relinked);
  }
  return { ...tree, rewritten };
}

/**
 * A raw destination rewritten to reach `place` from the file at `from`: in
 * the same form (angle brackets, root-relative or relative) and with its
 * fragment kept, each path segment percent-encoded.
 */
function destinationTo(raw: string, from: string, place: string): string {
  const bracketed = raw.startsWith('<');
  const inner = bracketed ? raw.slice(1, -1) : raw;
  const hash = inner.indexOf('#');
  const fragment = hash === -1 ? '' : inner.slice(hash);
  const path = inner.startsWith('/') ? `/${place}` : posix.relative(posix.dirname(from), place);
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return bracketed ? `<${encoded}${fragment}>` : `${encoded}${fragment}`;
}
