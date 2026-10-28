import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 无第三方依赖：使用本机 Chrome/Edge 的 CDP 验证独立 HTML 原型。
const root = path.resolve('design/tui-decoration');
const chrome = process.env.CHROME_PATH || [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'].map(name => path.join(base, name))).find(file => fs.existsSync(file));
if (!chrome) throw new Error('未找到浏览器；请通过 CHROME_PATH 指定 Chrome 或 Edge。');
const profile = path.resolve('.tmp', `tui-decor-browser-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await delay(100); }
  }
  assert.ok(port, '浏览器启动');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (!data.id) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(data.id);
    if (data.error) entry.reject(new Error(JSON.stringify(data.error))); else entry.resolve(data.result);
  });
  function call(method, params = {}) { return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  }); }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function navigate(query = '') {
    await call('Page.navigate', { url: pathToFileURL(path.join(root, 'index.html')).href + query });
    for (let i = 0; i < 100; i++) { if (await evaluate('typeof window.prototypeSnapshot === "function"')) return; await delay(20); }
    throw new Error('页面未就绪');
  }
  async function key(key, code, modifiers = 0) { await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); }
  async function clickHit(index) {
    const p = await evaluate(`(() => {const h=prototypeSnapshot().hits.find(h=>h.index===${index});const r=document.querySelector('#terminal').getBoundingClientRect();return {x:r.left+(h.x+2)*8.4,y:r.top+(h.y+.5)*22};})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  }
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1240, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate();
  let combinations = 0;
  for (const scheme of ['paper', 'orbit', 'amber']) for (const dark of [false, true]) for (const size of ['wide', 'medium', 'narrow', 'short']) for (const ascii of [false, true]) {
    const result = await evaluate(`(() => {scheme=${JSON.stringify(scheme)};dark=${dark};size=${JSON.stringify(size)};ascii=${ascii};reset();const s=prototypeSnapshot();const lineWidths=[...document.querySelectorAll('.line')].map(l=>[...l.children].reduce((n,c)=>n+parseFloat(getComputedStyle(c).width),0));return {...s,lineWidths,inputBottom:document.querySelector('#draft').offsetTop+document.querySelector('#draft').offsetHeight,terminalHeight:document.querySelector('#terminal').offsetHeight};})()`);
    assert.equal(result.lines.length, result.rows);
    assert.equal(result.hits.length, 6);
    assert.ok(result.hits.every(h => h.y >= 0 && h.y < result.rows - 5 && h.x + h.w <= result.mainW));
    assert.ok(result.lineWidths.every(w => Math.abs(w - result.cols * 8.4) < 2), `${scheme}/${size}: 字格宽度预算`);
    assert.ok(result.inputBottom < result.terminalHeight);
    if (size === 'narrow') assert.ok(result.lines.at(-1).includes('¥0.0000'), '窄屏保留上下文和费用');
    if (ascii) assert.ok(!/[─│╭╮╰╯●○█░▸]/u.test(result.lines.join('')), 'ASCII 装饰降级');
    combinations++;
  }
  for (const scheme of ['paper', 'orbit', 'amber']) {
    await navigate(`?scheme=${scheme}&capture=1`);
    await evaluate('document.fonts.ready');
    const snapshot = await evaluate('prototypeSnapshot()');
    assert.equal(snapshot.scheme, scheme);
    await evaluate("document.querySelector('#draft').focus()");
    await key('Tab', 'Tab');
    assert.equal((await evaluate('prototypeSnapshot()')).selected, 1);
    await key('Enter', 'Enter');
    assert.ok((await evaluate('prototypeSnapshot()')).draft.includes('检查当前工作区'));
    assert.equal((await evaluate('prototypeSnapshot()')).mode, 'home', '填草稿不发送');
    await key('Enter', 'Enter');
    let state = await evaluate('prototypeSnapshot()');
    assert.equal(state.mode, 'chat'); assert.equal(state.hits.length, 0, '发送后欢迎区收起');
    await key('Escape', 'Escape');
    await clickHit(2);
    assert.equal((await evaluate('prototypeSnapshot()')).draft, '我想实现一个功能：');
    await key('Escape', 'Escape');
    await clickHit(4);
    state = await evaluate('prototypeSnapshot()'); assert.equal(state.restored, '完善侧栏布局'); assert.equal(state.mode, 'chat');
    // 收起状态单独留一张图，用于判断装饰是否干扰对话。
    if (scheme === 'paper') {
      const chat = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1226, height: 868, scale: 1 } });
      fs.writeFileSync(path.join(root, 'conversation.png'), Buffer.from(chat.data, 'base64'));
    }
    await key('Escape', 'Escape');
    const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1226, height: 868, scale: 1 } });
    fs.writeFileSync(path.join(root, `${scheme}.png`), Buffer.from(shot.data, 'base64'));
  }
  await navigate('?scheme=paper&size=narrow&capture=1');
  const narrow = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 700, height: 744, scale: 1 } });
  fs.writeFileSync(path.join(root, 'narrow.png'), Buffer.from(narrow.data, 'base64'));
  await navigate();
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '手机宽度外层不横向溢出，终端在自身容器滚动');
  console.log(`PASS: ${combinations} 布局组合；三套方案真实键盘/鼠标交互、草稿不自动发送、发送收起、恢复演示、Esc 重置；手机外层布局。已生成 5 张预览。`);
  await call('Browser.close').catch(() => {});
} finally {
  socket?.close();
  browser.kill();
}
