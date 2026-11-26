// Commit fields as `git show -s --format=<format> <commit>` prints them,
// read from the commit object through the object reader. Only the
// placeholders below are read this way; for any other, for a commit git
// would re-encode (one with an `encoding` header, or a repository that sets
// a message encoding), for a shallow repository or one with grafts (git shows
// other parents than stored) and for a name that is no commit, git prints
// them.

import type { Git } from './git.ts';

const PLACEHOLDERS = /%(?:[TPBsn%]|ae)/g;
const SUPPORTED = /^(?:[^%]|%(?:[TPBsn%]|ae))*$/;

/** What `git.text(['show', '-s', `--format=${format}`, commit])` gives. */
export async function showCommit(git: Git, format: string, commit: string): Promise<string> {
  const plain = SUPPORTED.test(format) && await git.plainMessages() && !await git.rewritesHistory();
  const fields = plain ? await readCommit(git, commit) : undefined;
  if (fields === undefined) return git.text(['show', '-s', `--format=${format}`, commit]);
  const shown = format.replace(PLACEHOLDERS, (placeholder) => {
    switch (placeholder) {
      case '%T': return fields.tree;
      case '%P': return fields.parents.join(' ');
      case '%B': return fields.message;
      case '%s': return subject(fields.message);
      case '%ae': return fields.authorEmail;
      case '%n': return '\n';
      default: return '%';
    }
  });
  // `show` ends the output with a newline, and `text` takes one off.
  return shown;
}

/**
 * The most commits `ancestorWithin` reads before it leaves the answer to
 * git: a walk without generation numbers reads every commit it reaches, so a
 * "no" in a long history is git's to give.
 */
const ANCESTRY_COMMITS = 32;

/**
 * What `git merge-base --is-ancestor <ancestor> <descendant>` answers, read
 * from the commits below `descendant` through the object reader: true when
 * `ancestor` is one of them (or the same commit), false when all of them are
 * read without it. Undefined when git must answer: a history longer than
 * `ANCESTRY_COMMITS`, a name that is no commit, a commit git reads its own
 * way, or a shallow repository or one with grafts.
 */
export async function ancestorWithin(git: Git, ancestor: string, descendant: string): Promise<boolean | undefined> {
  if (await git.rewritesHistory()) return undefined;
  const [target, start] = await Promise.all([git.objectInfo(`${ancestor}^{commit}`), git.objectInfo(`${descendant}^{commit}`)]);
  if (target === null || start === null) return undefined;
  const seen = new Set([start.oid]);
  let frontier = [start.oid];
  let read = 0;
  while (frontier.length > 0) {
    if (seen.has(target.oid)) return true;
    read += frontier.length;
    if (read > ANCESTRY_COMMITS) return undefined;
    const commits = await Promise.all(frontier.map((oid) => readCommit(git, oid)));
    frontier = [];
    for (const commit of commits) {
      if (commit === undefined) return undefined;
      for (const parent of commit.parents) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        frontier.push(parent);
      }
    }
  }
  return seen.has(target.oid);
}

interface CommitFields {
  tree: string;
  parents: string[];
  authorEmail: string;
  message: string;
}

/** The fields of a commit git prints without re-encoding; undefined when git must print them. */
async function readCommit(git: Git, name: string): Promise<CommitFields | undefined> {
  const found = await git.readObject(name);
  if (found === null || found.type !== 'commit') return undefined;
  const text = found.content.toString('utf8');
  const end = text.indexOf('\n\n');
  if (end < 0) return undefined;
  // Only the layout git writes is read here: `tree`, its `parent` lines, one `author` and one `committer`, in that
  // order, then other headers. Git reads any other layout its own way, so it prints that commit.
  const lines = text.slice(0, end).split('\n');
  const tree = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(lines[0] ?? '')?.[1];
  let at = 1;
  const parents: string[] = [];
  for (let parent; (parent = /^parent ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(lines[at] ?? '')) !== null; at++) parents.push(parent[1] as string);
  const author = lines[at] ?? '';
  if (tree === undefined || !author.startsWith('author ') || !(lines[at + 1] ?? '').startsWith('committer ')) return undefined;
  const rest = lines.slice(at + 2);
  if (rest.some((line) => /^(?:tree|parent|author|committer|encoding) /.test(line))) return undefined;
  const authorEmail = email(author);
  if (authorEmail === undefined) return undefined;
  return { tree, parents, authorEmail, message: text.slice(end + 2) };
}

/** The address of an identity line, `<name> <<address>> <time> <zone>`, as git splits it. */
function email(line: string): string | undefined {
  const open = line.indexOf('<');
  const close = line.indexOf('>', open + 1);
  return open < 0 || close < 0 ? undefined : line.slice(open + 1, close);
}

/**
 * Git's subject (`%s`): after any blank lines, the lines up to the next
 * blank line, each without its trailing white space, joined by spaces.
 */
function subject(message: string): string {
  const lines = message.split('\n');
  // A message that ends in a newline has an empty last part, which git does not read as a line.
  if (lines.at(-1) === '') lines.pop();
  const trimmed = lines.map((line) => line.replace(/[ \t\n\r]+$/, ''));
  let first = 0;
  while (first < trimmed.length && trimmed[first] === '') first++;
  const taken: string[] = [];
  for (let index = first; index < trimmed.length && trimmed[index] !== ''; index++) taken.push(trimmed[index] as string);
  return taken.join(' ');
}
