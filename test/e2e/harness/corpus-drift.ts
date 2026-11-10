// Compare published slice expectations with today's bank and format rules.
import { copyBank } from '../../corpus/bank.ts';
import { DEFAULT_BANK, inLinearForm } from '../../corpus/generate.ts';
import { Canaries } from '../../corpus/model.ts';
import { duplicateTitles, linkedFileCheck, lintText } from '../../../src/format/index.ts';
import { type Manifest, type SliceList, owningFolder, annotatedFolders, inheritedTeam } from './corpus.ts';
import { EnvBlockedError } from './results.ts';

export async function assertCurrentCorpus(
  published: Manifest,
  slice: SliceList,
  read: (path: string) => Promise<string | null>,
  teams?: readonly string[],
): Promise<void> {
  const bank = copyBank(DEFAULT_BANK, new Canaries(() => { throw new Error('bank canary allocation'); }));
  inLinearForm(bank.files, DEFAULT_BANK);
  const currentBank = new Map(bank.files.map((file) => [file.path, file]));
  const before = new Map(published.files.map((file) => [file.path, file]));
  const selected = new Set(slice.paths);
  const differing = new Set<string>();
  const readmes = new Map<string, string>();
  if (teams !== undefined) {
    for (const path of published.files.map((file) => file.path).filter((path) => /(^|\/)README\.md$/.test(path))) {
      readmes.set(path, await read(path) ?? '');
    }
  }
  const folders = annotatedFolders(readmes);
  // Bank and full promise every bank file. The sampled mini/mid slices only
  // promise the files they select; a new bank document need not be sampled.
  if (slice.slice === 'bank' || slice.slice === 'full') {
    for (const file of bank.files) {
      if (teams !== undefined) {
        const folder = owningFolder(file.path, folders);
        if (folder !== null && !teams.includes(inheritedTeam(folder.folder, folders) ?? '')) continue;
      }
      if (!selected.has(file.path)) differing.add(file.path);
    }
  }
  const documents = slice.paths.filter((path) => before.get(path)?.synced && before.get(path)?.kind === 'markdown');
  const duplicateRules = new Map(duplicateTitles(documents).map((finding) => [finding.file, finding.rule]));
  for (const path of slice.paths) {
    const old = before.get(path);
    if (old === undefined) { differing.add(path); continue; }
    const bankFile = currentBank.get(path);
    if (bankFile !== undefined && (old.class !== bankFile.expected || old.rule !== bankFile.rule)) differing.add(path);
    if (!old.synced || old.kind !== 'markdown') continue;
    const text = await read(path);
    if (text === null) { differing.add(path); continue; }
    const rules = new Set<string>(lintText(path, text, {
      linkedFileExists: linkedFileCheck(path, (target) => before.has(target)),
    }).map((finding) => finding.rule));
    const duplicate = duplicateRules.get(path);
    if (duplicate !== undefined) rules.add(duplicate);
    if ((old.class === 'lint-error') !== (rules.size > 0)
      || (old.class === 'lint-error' && (old.rule === null || !rules.has(old.rule)))) differing.add(path);
  }
  if (differing.size > 0) throw new EnvBlockedError(`stale corpus manifest: ${[...differing].sort().join(', ')}; republish the corpus`);
}
