import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDsh as ensureRuntime, findDsh, installDsh as installRuntime, latestDshVersion, readDshVersion } from '../scripts/dsh-runtime.mjs';

const latestVersion = '1.2.3';
const ensureDsh = options => ensureRuntime({ latest: async () => latestVersion, ...options });
const installDsh = (directory, options) => installRuntime(directory, { version: latestVersion, ...options });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fakeDsh(directory, version = latestVersion) {
  const bin = join(directory, 'node_modules/@deepseek-ai/dsh/lib');
  await mkdir(bin, { recursive: true });
  const entry = join(bin, 'bin.js');
  await writeFile(entry, `console.log(${JSON.stringify(version)});\n`);
  return { command: process.execPath, args: [entry] };
}

test('latest DSH is reused without running an installer', async () => {
  const existing = { command: 'existing-dsh', args: [] };
  assert.deepEqual(await ensureDsh({ locate: async () => existing, versionOf: async () => latestVersion, upgrade: async () => assert.fail('unexpected install'), log() {} }), { ...existing, version: latestVersion });
});

test('an installed DSH is reused without querying npm, even when a different managed version exists',async t=>{
  const directory=await fixture(t);await fakeDsh(directory,'9.0.0');
  const existing=await fakeDsh(join(directory,'existing'),'0.2.0-rc.2');
  const result=await ensureRuntime({directory,locate:async()=>existing,latest:async()=>assert.fail('no npm query'),install:async()=>assert.fail('no install'),log(){}});
  assert.deepEqual(result,{...existing,version:'0.2.0-rc.2'});
});
test('an existing managed DSH is reused when PATH DSH is missing',async t=>{
  const directory=await fixture(t);await fakeDsh(directory);
  const runtime=await ensureRuntime({directory,locate:async()=>null,latest:async()=>assert.fail('no npm query'),install:async()=>assert.fail('no install'),log(){}});
  assert.equal(await readDshVersion(runtime),latestVersion);
});
test('missing or outdated DSH invokes the fixed-version upgrader',async t=>{
  const directory=await fixture(t);
  for (const installed of [null, '0.1.5-rc.1']) {
    const runtime=await ensureRuntime({directory,locate:async()=>installed?{command:'node',args:['old.js']}:null,versionOf:async candidate=>candidate?.args[0]==='old.js'?installed:null,
      locateNpm:async()=>({command:process.execPath,args:['npm-cli.js']}),upgrade:async options=>{assert.equal(options.version,installed);return {cli:'updated.js',version:'0.2.0-rc.2'};},log(){}});
    assert.deepEqual(runtime.args,['updated.js']);assert.equal(runtime.version,'0.2.0-rc.2');
  }
});

test('wrong downloaded version is rejected before replacing an old runtime', async t => {
  const base = await fixture(t), directory = join(base, latestVersion);
  const old = await fakeDsh(directory, '0.1.0');
  await assert.rejects(installDsh(directory, {
    locateNpm: async () => ({ command: 'test-npm', args: [] }),
    run: async (_command, args) => { await fakeDsh(args[args.indexOf('--prefix') + 1], '0.0.0'); },
  }), /版本校验失败/);
  assert.equal(await readDshVersion(old), '0.1.0'); assert.deepEqual(await readdir(base), [latestVersion]);
});

test('a broken managed runtime can be repaired after the replacement passes verification', async t => {
  const base = await fixture(t), directory = join(base, latestVersion);
  await fakeDsh(directory, '0.1.0');
  await installDsh(directory, {
    locateNpm: async () => ({ command: 'test-npm', args: [] }),
    run: async (_command, args) => { await fakeDsh(args[args.indexOf('--prefix') + 1]); },
  });
  assert.equal(await readDshVersion(await findDsh({ DSH_BIN: join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js') })), latestVersion);
  assert.deepEqual(await readdir(base), [latestVersion]);
});


test('latest version is queried from npm latest tag without a compatibility range', async () => {
  const version = await latestDshVersion({
    locateNpm: async () => ({ command: 'test-npm', args: ['npm-cli.js'] }),
    run: async (command, args) => {
      assert.equal(command, 'test-npm');
      assert.deepEqual(args, ['npm-cli.js', 'view', '@deepseek-ai/dsh@latest', 'version', '--json', '--prefer-online']);
      return { stdout: JSON.stringify('9.0.0-rc.1') };
    },
  });
  assert.equal(version, '9.0.0-rc.1');
});

test('startup does not query update services when an installed runtime is available',async()=>{
  const existing={command:'existing-dsh',args:[]};
  const runtime=await ensureRuntime({locate:async()=>existing,versionOf:async candidate=>candidate===existing?'0.2.0-rc.2':null,latest:async()=>assert.fail('no query'),install:async()=>assert.fail('no install'),log(){}});
  assert.deepEqual(runtime,{...existing,version:'0.2.0-rc.2'});
});
