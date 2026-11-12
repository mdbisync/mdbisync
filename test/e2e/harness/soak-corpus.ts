// A soak exercises propagation through the real all-files formatting check.
// Negative format fixtures belong to rejection scenarios, not its baseline.
import { duplicateTitles, fixText, linkedFileCheck, lintInTree } from '../../../src/format/index.ts';
import { parse, splitFile, visit } from '../../../src/format/markdown.ts';
import { linkedFile } from './checks.ts';
import type { Manifest, RunTree } from './corpus.ts';
import { EnvBlockedError } from './results.ts';

export function soakRunTree(tree: RunTree, manifest: Manifest, texts: ReadonlyMap<string, string>): RunTree {
  const negative = new Set(manifest.files.filter((file) => file.class === 'lint-error').map((file) => file.path));
  const paths = new Map([...tree.paths].filter(([, source]) => !negative.has(source)));
  const removed = new Set([...tree.paths.keys()].filter((path) => !paths.has(path)));
  const rewritten = new Map([...tree.rewritten].filter(([target]) => paths.has(target)));
  const files = new Set(paths.keys());
  const markdown = [...paths.keys()].filter((path) => path.endsWith('.md'));
  const problems = duplicateTitles(markdown).map((finding) => `${finding.file}: ${finding.rule}`);
  for (const target of markdown) {
    const source = paths.get(target)!;
    const text = rewritten.get(target) ?? texts.get(source);
    if (text === undefined) throw new EnvBlockedError(`soak corpus has no text for ${source}`);
    problems.push(...lintInTree(target, text, files).map((finding) => `${finding.file}: ${finding.rule}`));
    if (fixText(text, { linkedFileExists: linkedFileCheck(target, (path) => files.has(path)) }) !== text) {
      problems.push(`${target}: not in Linear's form`);
    }
    visit(parse(splitFile(text).body), (node) => {
      if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
      const dependency = linkedFile(target, node.url)?.path;
      if (dependency !== undefined && removed.has(dependency)) problems.push(`${target}: depends on omitted fixture ${dependency}`);
    });
  }
  // A stale manifest or a dependency on an omitted fixture must fail setup,
  // rather than silently excluding additional workload or weakening the hook.
  if (problems.length > 0) {
    throw new EnvBlockedError(`soak corpus is not format-clean: ${problems.join(', ')}`);
  }
  return { ...tree, paths, rewritten };
}
