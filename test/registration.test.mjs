import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerThinbook, migrateLauncherPatch, thinbookInstalled } from '../scripts/register-plugin.mjs';
const legacy='# user configuration\n- id: whereto\n  config:\n    port: 3789\n# >>> thinbook launcher >>>\n- insert:\n    - id: thinbook\n      name: "file:///project/plugin/index.mjs"\n      disabled: false\n      config:\n        dataRoot: "/preserve/readings"\n# <<< thinbook launcher <<<\n';
test('legacy file entry becomes a bundle override while preserving user YAML and dataRoot',()=>{
 const next=migrateLauncherPatch(legacy);assert.ok(next.startsWith('# user configuration\n- id: whereto\n  config:\n    port: 3789\n'));
 assert.match(next,/- id: thinbook\n  disabled: false\n  config:\n    dataRoot: "\/preserve\/readings"/);assert.doesNotMatch(next,/insert:|file:\/\//);assert.equal(migrateLauncherPatch(next),next);
 assert.throws(()=>migrateLauncherPatch('# >>> thinbook launcher >>>'),/标记不完整/);
});
for(const fail of [false,true])test(`official local bundle registration preserves store and rolls back failed migrations (failure: ${fail})`,async()=>{
 const home=await mkdtemp(join(tmpdir(),'thinbook-registration-')), root=join(home,'checkout'), profile=join(home,'profiles/web');
 await mkdir(root);await mkdir(join(profile,'node_modules'),{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({dependencies:{other:'link:/other'},dsh:{profile:{bundles:['other']}}}));
 const patch=join(profile,'cordis.patch.yml');await writeFile(patch,legacy);
 await writeFile(join(profile,'node_modules/.modules.yaml'),'packageManager: pnpm@12.3.4\nstoreDir: /existing/shared-store/v11\n');let installs=0;
 const options={home,root,runtime:{command:'node',args:['installed-dsh.js']},env:{PATH:'/existing/bin'},locatePnpm:async()=>({command:'pnpm',args:[]}),log:()=>{},run:async(command,args,{env})=>{
  if(args.includes('--version'))return{stdout:'12.3.4\n'};
  installs++;assert.deepEqual(args,['installed-dsh.js','plugin','--profile','web','add',`link:${root}`]);assert.equal(env.PNPM_CONFIG_STORE_DIR,'/existing/shared-store');assert.equal(env.npm_config_store_dir,'/existing/shared-store');
  assert.doesNotMatch(await readFile(patch,'utf8'),/insert:/);if(fail)throw Error('offline failure');
  await symlink(root,join(profile,'node_modules/thinbook'),'junction');await writeFile(join(profile,'package.json'),JSON.stringify({dependencies:{other:'link:/other',thinbook:`link:${root}`},dsh:{profile:{bundles:['other','thinbook']}}}));return{stdout:''};
 }};
 try{
  if(fail){await assert.rejects(registerThinbook(options),/offline failure/);assert.equal(await readFile(patch,'utf8'),legacy);}
  else {await registerThinbook(options);assert.equal(await thinbookInstalled(home,root),true);await registerThinbook({...options,run:()=>assert.fail('registered plugin must not run package manager again')});assert.match(await readFile(patch,'utf8'),/dataRoot: "\/preserve\/readings"/);}
  assert.equal(installs,1);
 }finally{await rm(home,{recursive:true,force:true});}
});
