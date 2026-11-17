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
      '<svg><a href="#safe"><set attributeName="href" to="javascript:alert(1)"/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:object data="https://example.com/page.html"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/style.css);</style><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill: url(https://example.com/paint.svg#p)"/></svg>',
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
    assert.equal(notice.body,'Some images in this document cannot be synchronized. Fix the listed images and sync again.\n\n' + bad.map((_,index) => `- Image ${expected.length + index + 1} of ${expected.length + bad.length} (line ${(expected.length + index) * 2 + 1}): ${reason}`).join('\n'));
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

it('blocks a document that reuses a captured file the stricter check now refuses, and still links a static one', async () => {
  const fixture = await createFixture();
  const config = resolveStateConfig({});
  try {
    // An SVG the earlier deny-list admitted, stored under the name a capture gives, and a static one.
    const old = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/></svg>');
    const shapes = await readFile(new URL('../fixtures/assets/shapes.svg',import.meta.url));
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    await fixture.seed({
      'docs/README.md':'---\nlinear-team: ENG\nlinear-project: Field notes\n---\n\n# Notes\n',
      'docs/mapped.md':'Mapped.\n','docs/copied.md':'Copied.\n','docs/static.md':'Static.\n',
      [`docs/${hash(old)}.svg`]:old,[`docs/${hash(shapes)}.svg`]:shapes,
      '.pre-commit-config.yaml':'repos:\n  - repo: https://github.com/example/mdbisync\n    rev: 0123456789abcdef0123456789abcdef01234567\n    hooks:\n      - id: linear-format\n',
    });
    const git = await fixture.clone('engine');
    const fetched = await fetchState(git, config);
    const mappedUrl = 'https://uploads.linear.app/old.svg';
    const copiedUrl = 'https://uploads.linear.app/copy.svg';
    const staticUrl = 'https://uploads.linear.app/shapes.svg';
    const initial = {
      linear:await commitTree(git, {parents:[fetched.tracked], base:fetched.tracked, changes:new Map(), message:'Initial state', identity:IDENTITY}),
      ids:await commitIds(git, null, new Map([['docs/mapped.md',{id:'mapped'}],['docs/copied.md',{id:'copied'}],['docs/static.md',{id:'static'}]]), IDENTITY),
      uploads:await commitUploads(git, null, new Map([[hash(old),mappedUrl],[hash(shapes),staticUrl]]), IDENTITY),
    };
    assert.equal((await pushAtomic(git, config, Object.entries(initial).map(([store,next]) => ({ref:stateRef(config,store as 'linear'|'ids'|'uploads'), expected:null, next})))).ok, true);
    const world = fakeWorld();
    // The same bytes under a URL the upload map does not hold: found by downloading them.
    world.linear.uploads.push({filename:'copy.svg',assetUrl:copiedUrl,bytes:old,size:old.length,contentType:'image/svg+xml'});
    const documents = [['mapped',mappedUrl],['copied',copiedUrl],['static',staticUrl]].map(([id,url]) => ({id:id!,title:id!,content:`Text.\n\n![Image](${url})\n`,projectId:'project-api',icon:'Fire',color:'#123456',createdAt:'2026-01-01T00:00:00Z'}));
    world.linear.documents.push(...documents);
    const result = await runCli(['sync'],{cwd:git.dir,fetch:fakeFetch(world),env:{
      MDBISYNC_LINEAR_CLIENT_ID:'client',MDBISYNC_LINEAR_CLIENT_SECRET:'secret',MDBISYNC_LINEAR_API_URL:LINEAR_API,
      MDBISYNC_MERGE_GRACE_SECONDS:'0',MDBISYNC_GITHUB_TOKEN:'token',MDBISYNC_GITHUB_API_URL:GITHUB_API,
      MDBISYNC_REPOSITORY:'example/repository',MDBISYNC_REPORT_FILE:join(fixture.root,'report.json'),
    }});
    assert.equal(result.exitCode,0,result.stderr);
    const report = JSON.parse(await readFile(join(fixture.root,'report.json'),'utf8'));
    assert.deepEqual(report.capture.blocked.map((item: {id:string}) => item.id).sort(),['copied','mapped']);
    const reason = '- Image 1 of 1 (line 3): the uploaded file is not a supported image or document. Remove it or upload the original file.';
    const notices = [...world.linear.comments.values()];
    assert.equal(notices.length,2);
    for (const notice of notices) assert.equal(notice.body,`Some images in this document cannot be synchronized. Fix the listed images and sync again.\n\n${reason}`);
    assert.deepEqual(documents.map(({icon}) => icon),['Cross','Cross','Fire']);
    const show = (path: string) => fixture.remote.text(['show',`${stateRef(config,'linear')}:${path}`]);
    assert.equal(await show('docs/mapped.md'),'Mapped.');
    assert.equal(await show('docs/copied.md'),'Copied.');
    assert.equal(await show('docs/static.md'),`Text.\n\n![Image](${hash(shapes)}.svg)`);
  } finally {await fixture.cleanup();}
});
