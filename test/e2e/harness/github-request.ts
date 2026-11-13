import { outputText } from '../../../src/run/output.ts';

/** Only the JSON fields used by the harness's GitHub operations can leave it. */
const TEXT_FIELDS = ['ref', 'sha', 'message', 'head', 'base', 'title', 'body'] as const;
const FIELDS = new Set<string>([...TEXT_FIELDS, 'content', 'state', 'merge_method', 'repositories', 'inputs', 'permissions']);

export function githubRequestBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub request body');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !FIELDS.has(key))) throw new Error('Unknown GitHub request field');
  const result: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS) {
    if (input[key] !== undefined) result[key] = outputText(input[key], key === 'body' ? 65536 : 4096);
  }
  if (input.content !== undefined) {
    const content = outputText(input.content);
    if (content.trim() !== content || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error('Invalid GitHub file content');
    result.content = content;
  }
  if (input.state !== undefined) {
    if (input.state !== 'open' && input.state !== 'closed') throw new Error('Invalid pull request state');
    result.state = input.state;
  }
  if (input.merge_method !== undefined) {
    if (input.merge_method !== 'merge' && input.merge_method !== 'squash' && input.merge_method !== 'rebase') throw new Error('Invalid merge method');
    result.merge_method = input.merge_method;
  }
  if (input.repositories !== undefined) {
    if (!Array.isArray(input.repositories) || input.repositories.length > 100) throw new Error('Invalid repositories');
    result.repositories = input.repositories.map((value: unknown) => {
      const name = outputText(value, 100);
      if (name.trim() !== name || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid repository name');
      return name;
    });
  }
  if (input.permissions !== undefined) {
    // An installation token scoped down to some of the App's permissions.
    if (input.permissions === null || typeof input.permissions !== 'object' || Array.isArray(input.permissions)) throw new Error('Invalid token permissions');
    const entries = Object.entries(input.permissions);
    if (entries.length === 0 || entries.length > 50) throw new Error('Invalid token permissions');
    result.permissions = Object.fromEntries(entries.map(([key, value]) => {
      if (!/^[a-z_]{1,50}$/.test(key) || (value !== 'read' && value !== 'write')) throw new Error('Invalid token permission');
      return [key, value];
    }));
  }
  if (input.inputs !== undefined) {
    if (input.inputs === null || typeof input.inputs !== 'object' || Array.isArray(input.inputs)) throw new Error('Invalid workflow inputs');
    const entries = Object.entries(input.inputs);
    if (entries.length > 100) throw new Error('Too many workflow inputs');
    result.inputs = Object.fromEntries(entries.map(([key, value]) => {
      if (key.trim() !== key || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key)) throw new Error('Invalid workflow input name');
      return [key, outputText(value, 10000)];
    }));
  }
  return result;
}

export function githubRequestPath(path: string): string {
  if (path.length > 8192 || path.trim() !== path || !/^\/[A-Za-z0-9_.~!$&'()*+,;=:@%/?-]*$/.test(path)) throw new Error('Invalid GitHub API path');
  return path;
}

export function githubRequestToken(token: string): string {
  if (token.length > 8192 || token.trim() !== token || !/^[A-Za-z0-9._-]+$/.test(token)) throw new Error('Invalid GitHub authentication token');
  return token;
}
