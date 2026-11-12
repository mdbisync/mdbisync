import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { runCli } from '../../src/cli.ts';
import { lintInTree } from '../../src/format/index.ts';
import { fakeWorld, fakeFetch, LINEAR_API, GITHUB_API, touch } from '../../src/setup/test-helpers.ts';
import { commitIds, commitTree, commitUploads, fetchState, listTree, readBlobs, pushAtomic, resolveStateConfig, stateRef } from '../../src/state/index.ts';
import { createFixture, IDENTITY } from '../../src/state/test-helpers.ts';

it('the CLI blocks unsupported upload bytes and captures every supported type after correction', async () => {
  const fixture = await createFixture();
  const config = resolveStateConfig({});
  try {
    await fixture.seed({
      'docs/README.md':'---\nlinear-team: ENG\nlinear-project: Field notes\n---\n\n# Notes\n',
      'docs/plan.md':'Original.\n',
      '.pre-commit-config.yaml':'repos:\n  - repo: https://github.com/example/mdbisync\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n',
    });
    const git = await fixture.clone('engine');
    const fetched = await fetchState(git, config);
    const initial = {
      linear:await commitTree(git, {parents:[fetched.tracked], base:fetched.tracked, changes:new Map(), message:'Initial state', identity:IDENTITY}),
      ids:await commitIds(git, null, new Map([['docs/plan.md',{id:'plan'}]]), IDENTITY),
      uploads:await commitUploads(git, null, new Map(), IDENTITY),
    };
    assert.equal((await pushAtomic(git, config, Object.entries(initial).map(([store,next]) => ({ref:stateRef(config,store as 'linear'|'ids'|'uploads'), expected:null, next})))).ok, true);
    const world = fakeWorld();
    const document = {id:'plan',title:'plan',content:'',projectId:'project-api',icon:'Fire',color:'#123456',createdAt:'2026-01-01T00:00:00Z'};
    world.linear.documents.push(document);
    const files = ['pixel.png','photo.jpg','blink.gif','pixel.webp','summary.pdf','clip.mp4','clip.webm','shapes.svg'];
    const assets = await Promise.all(files.map(async (file) => ({file,bytes:await readFile(new URL(`../fixtures/assets/${file}`,import.meta.url))})));
    assets.push({file:'upload-pixel.avif',bytes:await readFile(new URL('../data/upload-pixel.avif',import.meta.url))});
    const expected = assets.map(({file,bytes},index) => {
      const url = `https://uploads.linear.app/new-${index}.${index % 2 ? 'md' : 'html'}`;
      world.linear.uploads.push({filename:file,assetUrl:url,bytes,size:bytes.length,contentType:'image/png'});
      const ext = file.slice(file.lastIndexOf('.'));
      return {url,path:`docs/${createHash('sha256').update(bytes).digest('hex')}${ext}`,bytes};
    });
    const bad = [
      '<html><body>Page</body></html>',
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>',
      '<!-- page --><html/>', '<svg><script/></svg>', '<svg onload="run()"/>',
      '<svg><foreignObject/></svg>', '<svg><use href="https://example.com/picture.svg"/></svg>',
    ];
    bad.forEach((text,index) => world.linear.uploads.push({filename:'image.png',assetUrl:`https://uploads.linear.app/bad-${index}.png`,bytes:Buffer.from(text),size:text.length,contentType:'image/png'}));
    const goodBody = expected.map(({url}) => `![Image](${url})`).join('\n\n') + '\n';
    document.content = goodBody + '\n' + bad.map((_,index) => `![Image](https://uploads.linear.app/bad-${index}.png)`).join('\n\n') + '\n';
    const run = async () => {
      const reportFile = join(fixture.root, 'report.json');
      const result = await runCli(['sync'],{cwd:git.dir,fetch:fakeFetch(world),env:{
        MDBISYNC_LINEAR_CLIENT_ID:'client',MDBISYNC_LINEAR_CLIENT_SECRET:'secret',MDBISYNC_LINEAR_API_URL:LINEAR_API,
        MDBISYNC_MERGE_GRACE_SECONDS:'0',MDBISYNC_GITHUB_TOKEN:'token',MDBISYNC_GITHUB_API_URL:GITHUB_API,
        MDBISYNC_REPOSITORY:'example/repository',MDBISYNC_REPORT_FILE:reportFile,
      }});
      assert.equal(result.exitCode,0,result.stderr);
      const tree = await listTree(git,stateRef(config,'linear'));
      const paths = new Set(tree.map(({path}) => path));
      const markdown = tree.filter(({path}) => path.endsWith('.md'));
      const blobs = await readBlobs(git,markdown.map(({oid}) => oid));
      for (const {path,oid} of markdown) assert.deepEqual(lintInTree(path,blobs.get(oid)!.toString(),paths),[]);
      return JSON.parse(await readFile(reportFile,'utf8'));
    };
    const blocked = await run();
    assert.equal(blocked.capture.blocked.length,1);
    assert.equal(await fixture.remote.text(['show',`${stateRef(config,'linear')}:docs/plan.md`]),'Original.');
    assert.equal(document.icon,'Cross');
    const notice = [...world.linear.comments.values()][0]!;
    const reason = 'the uploaded file is not a supported image or document. Remove it or upload the original file.';
    assert.equal(notice.body,'Some images in this document cannot be synchronized. Fix the listed images and sync again.\n\n' + bad.map((_,index) => `- Image ${index + 10} of 16 (line ${index * 2 + 19}): ${reason}`).join('\n'));
    await run();
    assert.equal(world.linear.comments.size,1);
    document.content = goodBody;
    touch(document);
    const fixed = await run();
    assert.equal(fixed.capture.blocked.length,0);
    assert.equal(notice.resolved,true);
    assert.equal(document.icon,'Fire');
    assert.equal(document.color,'#123456');
    for (const {path,bytes} of expected) {
      const actual = await fixture.remote.run(['show',`${stateRef(config,'linear')}:${path}`]);
      assert.deepEqual(actual.stdout,bytes);
    }
  } finally {await fixture.cleanup();}
});
