/**
 * 录制 1080x1920 竖屏视频
 * 用法: node record.cjs [--duration 30000] [--mode video|shots]
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('C:/Users/HUAWEI/node_modules/playwright');

const OUT = __dirname;
const HTML = path.join(OUT, 'index.html');
const DURATION = Number((process.argv.find(a => a.startsWith('--duration=')) || '--duration=30600').split('=')[1]);
const MODE = (process.argv.find(a => a.startsWith('--mode=')) || '--mode=video').split('=')[1];

// 质量检查用的关键帧（ms）
const SHOTS = [
  ['01-hook',    2600],
  ['02-pain',    7000],
  ['03-turn',    9100],
  ['04-demo-a', 11800],
  ['05-demo-b', 15600],
  ['06-demo-c', 22400],
  ['07-points', 26200],
  ['08-cta',    29600],
];

(async () => {
  const browser = await chromium.launch({
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    ...(MODE === 'video'
      ? { recordVideo: { dir: OUT, size: { width: 1080, height: 1920 } } }
      : {}),
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  if (MODE === 'video') {
    console.log('[record] 开始录制，目标时长 ' + DURATION + 'ms');
    await page.goto('file:///' + HTML.replace(/\\/g, '/'));
    await page.waitForTimeout(DURATION);
    const v = page.video();
    await context.close();               // 必须先 close 才会落盘
    const src = await v.path();
    const dst = path.join(OUT, 'wenlang-agent-douyin-30s.webm');
    fs.renameSync(src, dst);
    console.log('[record] 输出: ' + dst);
    console.log('[record] 大小: ' + (fs.statSync(dst).size / 1024 / 1024).toFixed(2) + ' MB');
  } else {
    fs.mkdirSync(path.join(OUT, 'qc'), { recursive: true });
    for (const [name, ms] of SHOTS) {
      await page.goto('file:///' + HTML.replace(/\\/g, '/') + '?t=' + ms);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, 'qc', name + '.png') });
      console.log('[shot] ' + name + ' @ ' + ms + 'ms');
    }
    await context.close();
  }

  await browser.close();
  if (errors.length) {
    console.log('[warn] 页面报错:');
    errors.forEach(e => console.log('   ' + e));
  } else {
    console.log('[ok] 无页面错误');
  }
})().catch(e => { console.error(e); process.exit(1); });
