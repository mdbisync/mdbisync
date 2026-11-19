// The workflows on the sandbox's default branch. Two are the harness's own
// and are installed by hand from this repository: the scheduled sync
// (`cli.ts scheduler --install`, renderScheduler) and the format probe's
// daily drift run (`cli.ts format-probe --install`, test/probe/drift-workflow.yml).
// `cli.ts workflows` reads every workflow there and names the settings each
// reads, so a renamed setting cannot stay in use unnoticed: the sandbox's
// settings are SANDBOX_WORKFLOW_SETTINGS, the canary's key and GitHub's
// own token, and any other `vars.` or `secrets.` name is reported, as is a
// file that is not valid YAML. Only names are read; a workflow file holds
// no setting values.

import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { CANARY_SECRET, SANDBOX_WORKFLOW_SETTINGS, SCHEDULER_FILE } from './workflow-files.ts';

/** The format probe's drift workflow in the sandbox's `.github/workflows/`. */
export const FORMAT_PROBE_FILE = 'format-probe.yml';

const FORMAT_PROBE_SOURCE = new URL('../../probe/drift-workflow.yml', import.meta.url);

/** The format probe's drift workflow, as the sandbox installs it: the file as it is here. */
export function formatProbeWorkflow(): string {
  return readFileSync(FORMAT_PROBE_SOURCE, 'utf8');
}

/** The workflows the harness installs on the default branch; `workflows --remove` never removes them. */
export const HARNESS_WORKFLOWS: readonly string[] = [SCHEDULER_FILE, FORMAT_PROBE_FILE];

const KNOWN: Record<'vars' | 'secrets', ReadonlySet<string>> = {
  vars: new Set(SANDBOX_WORKFLOW_SETTINGS.vars),
  secrets: new Set([...SANDBOX_WORKFLOW_SETTINGS.secrets, CANARY_SECRET, 'GITHUB_TOKEN']),
};

/** A setting as a workflow names it: `vars.NAME` or `secrets.NAME`; `vars.*` or `secrets.*` for the whole context. */
export type SettingName = `${'vars' | 'secrets'}.${string}`;

// A context outside a property path: `steps.vars.outputs` and `inputs.secrets` name no setting.
const CONTEXT = String.raw`(?<![\w.-])(vars|secrets)`;
const INDEXED = new RegExp(String.raw`${CONTEXT}\s*\[\s*'((?:[^']|'')*)'\s*\]`, 'gi');
const DOTTED = new RegExp(String.raw`${CONTEXT}\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)`, 'gi');
const WHOLE = new RegExp(String.raw`${CONTEXT}(?![\w-])`, 'gi');
// An expression's string literal: single quotes, a doubled quote inside.
const LITERAL = /'(?:[^']|'')*'/g;

/** The settings one expression reads, without `${{ }}`. Text in string literals reads nothing. */
function expressionSettings(expression: string, names: Set<SettingName>): void {
  const add = (context: string, name: string) => names.add(`${context.toLowerCase() as 'vars' | 'secrets'}.${name === '*' ? name : name.toUpperCase()}`);
  let rest = expression.replace(INDEXED, (_, context: string, name: string) => { add(context, name.replace(/''/g, "'")); return ' '; });
  rest = rest.replace(LITERAL, ' ');
  rest = rest.replace(DOTTED, (_, context: string, name: string) => { add(context, name); return ' '; });
  // What is left reads the whole context: toJSON(secrets), a computed index.
  for (const match of rest.matchAll(WHOLE)) add(match[1] as string, '*');
}

/** The expressions in a string: each `${{ … }}`, ending at the first `}}` outside a string literal. */
function expressions(value: string): string[] {
  const found: string[] = [];
  let start = value.indexOf('${{');
  while (start !== -1) {
    let at = start + 3;
    let quoted = false;
    for (; at < value.length; at += 1) {
      if (value[at] === "'") quoted = !quoted;
      else if (!quoted && value.startsWith('}}', at)) break;
    }
    found.push(value.slice(start + 3, at));
    start = value.indexOf('${{', at + 2);
  }
  return found;
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * The settings a workflow reads, sorted: every `vars.` and `secrets.` name in
 * its expressions, by GitHub's rule that names do not depend on case. An
 * expression is each `${{ }}` in any value, and a job's or a step's whole
 * `if:` without them. A job that calls a reusable workflow with
 * `secrets: inherit`, and a whole context (`toJSON(secrets)`), read
 * `secrets.*`. YAML aliases are read where they are used. Comments, string
 * literals and plain text such as a shell command read nothing.
 */
export function settingsRead(text: string): SettingName[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    // The parser's message quotes the source; the report keeps to names and positions.
    const { code, linePos } = doc.errors[0]!;
    throw new Error(`the workflow is not valid YAML: ${code}${linePos === undefined ? '' : ` at line ${linePos[0].line}`}`);
  }
  const workflow: unknown = doc.toJS({ maxAliasCount: 1000 });
  const names = new Set<SettingName>();
  const scan = (value: unknown, isCondition = false): void => {
    if (typeof value === 'string') {
      const found = expressions(value);
      for (const expression of found.length === 0 && isCondition ? [value] : found) expressionSettings(expression, names);
    } else if (Array.isArray(value)) {
      for (const item of value) scan(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        scan(key);
        scan(item);
      }
    }
  };
  scan(workflow);
  // Only a job's and a step's `if:` are expressions without `${{ }}`, and only a job's `secrets: inherit` passes every secret.
  for (const job of Object.values(record(record(workflow)['jobs']))) {
    const { if: condition, secrets, steps } = record(job);
    scan(condition, true);
    if (secrets === 'inherit') names.add('secrets.*');
    for (const step of Array.isArray(steps) ? steps : []) scan(record(step)['if'], true);
  }
  return [...names].sort();
}

/** Whether `setting` is one the sandbox provides; a whole context never is. */
export function knownSetting(setting: SettingName): boolean {
  const dot = setting.indexOf('.');
  const context = setting.slice(0, dot) as 'vars' | 'secrets';
  return KNOWN[context].has(setting.slice(dot + 1));
}

export interface WorkflowSettings {
  file: string;
  /** The file's blob, so a removal deletes the version that was read. */
  sha: string;
  reads: SettingName[];
  /** The settings it reads that the sandbox does not provide. */
  unknown: SettingName[];
  /** Why the file could not be read as a workflow; then `reads` is empty. */
  error?: string;
}

export interface SandboxWorkflowsReport {
  /** Every workflow file on the default branch. */
  files: WorkflowSettings[];
  /**
   * Workflows GitHub has registered that are not on the default branch: they
   * are on another branch, or their file was deleted, and are not read.
   */
  elsewhere: string[];
}

/** Whether a workflow fails the read: it reads an unknown setting or is not a workflow. */
export function failsRead(entry: WorkflowSettings): boolean {
  return entry.unknown.length > 0 || entry.error !== undefined;
}

/** What the read needs of the sandbox's REST API (SandboxRest). */
export interface WorkflowSource {
  directory(path: string): Promise<string[] | undefined>;
  fileBlob(path: string): Promise<{ text: string; sha: string } | undefined>;
  workflowPaths(): Promise<string[]>;
}

const DIR = '.github/workflows';

/** Reads every workflow on the sandbox's default branch for the settings it reads. */
export async function readSandboxWorkflows(rest: WorkflowSource): Promise<SandboxWorkflowsReport> {
  const names = ((await rest.directory(DIR)) ?? []).filter((name) => /\.ya?ml$/.test(name)).sort();
  const files: WorkflowSettings[] = [];
  for (const file of names) {
    const blob = await rest.fileBlob(`${DIR}/${file}`);
    if (blob === undefined) throw new Error(`${DIR}/${file} disappeared while it was read`);
    try {
      const reads = settingsRead(blob.text);
      files.push({ file, sha: blob.sha, reads, unknown: reads.filter((setting) => !knownSetting(setting)) });
    } catch (error) {
      files.push({ file, sha: blob.sha, reads: [], unknown: [], error: (error as Error).message });
    }
  }
  const onDefault = new Set(names.map((name) => `${DIR}/${name}`));
  const elsewhere = (await rest.workflowPaths()).filter((path) => path.startsWith(`${DIR}/`) && !onDefault.has(path)).sort();
  return { files, elsewhere };
}

/**
 * Why `workflows --remove <file>` refuses to remove `file`, or undefined when
 * it may: only a workflow the harness does not install, on the default
 * branch, that fails the read (failsRead). Such a workflow has no source
 * here to regenerate it from.
 */
export function removalRefusal(report: SandboxWorkflowsReport, file: string): string | undefined {
  if (HARNESS_WORKFLOWS.includes(file)) return `${file} is the harness's own; install it again instead`;
  const entry = report.files.find((candidate) => candidate.file === file);
  if (entry === undefined) return `${file} is not on the default branch`;
  if (!failsRead(entry)) return `${file} reads only settings the sandbox provides`;
  return undefined;
}
