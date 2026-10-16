import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { root } from '../harness/reader.mjs';
const anchor=join(root,'node_modules/@deepseek-ai/dsh/package.json'),require=createRequire(anchor);
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const {PluginManager}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager')).href);

test('DSH installed plugins show ThinBook once with Chinese title, icon and a manageable bundle',async()=>{
 const home=await mkdtemp(join(tmpdir(),'thinbook-list-')),dir=join(home,'profiles/web'),ctx=new Context();
 try{
  await mkdir(join(dir,'node_modules'),{recursive:true});await symlink(root,join(dir,'node_modules/thinbook'),process.platform==='win32'?'junction':'dir');
  const manifest={private:true,dsh:{profile:{bundles:[]}}};await writeFile(join(dir,'package.json'),JSON.stringify(manifest));
  await writeFile(join(dir,'cordis.patch.yml'),'- insert:\n    - id: thinbook\n      name: file:///old/plugin/index.mjs\n');
  ctx.provide('loader',{entries:()=>[]});ctx.provide('profileContext',{name:'web',dir,installAnchor:anchor,startedBundles:[]});await ctx.plugin(PluginManager);
  assert.equal((await ctx.pluginManager.listBundles()).filter(item=>item.installed).some(item=>item.name==='thinbook'),false,'a raw file patch is not an installed bundle');
  manifest.dependencies={thinbook:`link:${root}`};manifest.dsh.profile.bundles=['thinbook'];await writeFile(join(dir,'package.json'),JSON.stringify(manifest));
  await writeFile(join(dir,'cordis.patch.yml'),'- id: thinbook\n  config:\n    dataRoot: /preserved/data\n');
  const matches=(await ctx.pluginManager.listBundles()).filter(item=>item.installed&&item.name==='thinbook');assert.equal(matches.length,1);
  const item=matches[0];assert.equal(item.enabled,true);assert.equal(item.removable,true);assert.equal(item.error,undefined);
  assert.equal(item.meta.title.zh,'薄书 · DSH Web 阅读工作室');assert.ok(item.meta.icon.startsWith('data:image/svg+xml;base64,'));assert.deepEqual(item.rows.map(row=>row.rowId),['thinbook']);
 }finally{await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});}
});
