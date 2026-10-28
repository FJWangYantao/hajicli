import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=path.resolve('design/tui-layouts');
const chrome=process.env.CHROME_PATH||[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).flatMap(p=>['Google/Chrome/Application/chrome.exe','Microsoft/Edge/Application/msedge.exe'].map(f=>path.join(p,f))).find(f=>fs.existsSync(f));
assert.ok(chrome,'需要 Chrome/Edge 或 CHROME_PATH');
const profile=path.resolve('.tmp','layout-browser-'+Date.now());fs.mkdirSync(profile,{recursive:true});
const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let socket;
try{
 let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{await delay(100)}}assert.ok(port);
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true})});
 let id=0;const pending=new Map();socket.addEventListener('message',e=>{const d=JSON.parse(e.data),p=pending.get(d.id);if(p){pending.delete(d.id);clearTimeout(p.timer);d.error?p.reject(Error(JSON.stringify(d.error))):p.resolve(d.result)}});
 function call(method,params={}){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error(method+' timeout'))},15000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}))})}
 async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value}
 async function navigate(query){await call('Page.navigate',{url:pathToFileURL(path.join(root,'index.html')).href+query});for(let i=0;i<100;i++){if(await evaluate('typeof prototypeSnapshot === "function"')){const state=await evaluate('prototypeSnapshot()');if(new URLSearchParams(query).get('layout')===state.layout)return}await delay(20)}throw Error('页面加载失败')}
 async function key(key){await call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key})}
 async function click(index){const p=await evaluate(`(()=>{const h=prototypeSnapshot().hits.find(h=>h.index===${index}),r=document.querySelector('#terminal').getBoundingClientRect();return {x:r.left+(h.x+2)*8.4,y:r.top+(h.y+.5)*22}})()`);await call('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1})}
 async function shot(file,narrow=false){await evaluate('document.fonts.ready');const r=await call('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:narrow?700:1226,height:narrow?744:868,scale:1}});fs.writeFileSync(path.join(root,file),Buffer.from(r.data,'base64'))}
 await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1240,height:900,deviceScaleFactor:1,mobile:false});
 let count=0;const signatures=[];
 for(const layout of ['center','split','desk']){
  for(const size of ['wide','medium','narrow','short']){
   await navigate(`?layout=${layout}&size=${size}&capture=1`);
   const s=await evaluate('prototypeSnapshot()');assert.equal(s.hits.length,6);
   for(const r of [...s.regions,...s.hits])assert.ok(r.x>=0&&r.y>=0&&r.x+r.w<=s.cols&&r.y+r.h<=s.rows,`${layout}/${size}: bounds ${JSON.stringify(r)}`);
   const overlaps=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
   for(const h of s.hits){assert.ok(!overlaps(h,s.regions.find(r=>r.name==='input')),`${layout}/${size}: 输入区和入口重叠`);}
   for(let i=0;i<s.regions.length;i++)for(let j=i+1;j<s.regions.length;j++)assert.ok(!overlaps(s.regions[i],s.regions[j]),`${layout}/${size}: ${s.regions[i].name}与${s.regions[j].name}重叠`);
   const widths=await evaluate("[...document.querySelectorAll('.line')].map(l=>[...l.children].reduce((n,c)=>n+parseFloat(getComputedStyle(c).width),0))");assert.ok(widths.every(w=>Math.abs(w-s.cols*8.4)<2));
   for(const text of ['了解当前项目','检查工作区','描述一个需求','图片自然度调整','完善侧栏布局','修复会话恢复','master','¥0.0000'])assert.ok(s.lines.join('\n').includes(text),`${layout}/${size}: 缺 ${text}`);
   if(size==='wide'){signatures.push(JSON.stringify(s.regions));await shot(layout+'.png')}
   if(size==='narrow')await shot(layout+'-narrow.png',true);
   count++;
  }
  await navigate(`?layout=${layout}&capture=1`);await evaluate("document.querySelector('#draft').focus()");await key('Tab');assert.equal((await evaluate('prototypeSnapshot()')).selected,1);await key('Enter');assert.ok((await evaluate('prototypeSnapshot()')).draft.includes('检查当前工作区'));assert.equal((await evaluate('prototypeSnapshot()')).mode,'home');await key('Enter');assert.equal((await evaluate('prototypeSnapshot()')).hits.length,0);await key('Escape');await click(2);assert.equal((await evaluate('prototypeSnapshot()')).draft,'我想实现一个功能：');await key('Escape');await click(4);assert.equal((await evaluate('prototypeSnapshot()')).restored,'完善侧栏布局');
 }
 assert.equal(new Set(signatures).size,3,'三套布局几何结构必须不同');
 await navigate('?layout=center');await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
 console.log(`PASS: ${count} 布局/尺寸组合，区块无重叠、字格宽度、六入口与关键内容；三套结构不同；实际键鼠、发送收起、恢复与手机外层布局。生成6张预览。`);
 await call('Browser.close').catch(()=>{});
}finally{socket?.close();browser.kill()}
