// A soak exercises propagation through the real all-files formatting check.
// Negative format fixtures belong to rejection scenarios, not its baseline.
import { duplicateTitles, lintInTree } from '../../../src/format/index.ts';
import type { Manifest, RunTree } from './corpus.ts';
import { EnvBlockedError } from './results.ts';

export function soakRunTree(tree: RunTree, manifest: Manifest, texts: ReadonlyMap<string, string>): RunTree {
  const negative = new Set(manifest.files.filter((file) => file.class === 'lint-error').map((file) => file.path));
  const paths = new Map([...tree.paths].filter(([, source]) => !negative.has(source)));
  const rewritten = new Map([...tree.rewritten].filter(([target]) => paths.has(target)));
  const files = new Set(paths.keys());
  const markdown = [...paths.keys()].filter((path) => path.endsWith('.md'));
  const findings = duplicateTitles(markdown);
  for (const target of markdown) {
    const source = paths.get(target)!;
    const text = rewritten.get(target) ?? texts.get(source);
    if (text === undefined) throw new EnvBlockedError(`soak corpus has no text for ${source}`);
    findings.push(...lintInTree(target, text, files));
  }
  // A stale manifest or a dependency on an omitted fixture must fail setup,
  // rather than silently excluding additional workload or weakening the hook.
  if (findings.length > 0) {
    throw new EnvBlockedError(`soak corpus is not format-clean: ${findings.map((finding) => `${finding.file}: ${finding.rule}`).join(', ')}`);
  }
  return { ...tree, paths, rewritten };
}
