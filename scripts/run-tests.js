// 测试引导：启动服务、依次跑闭环场景与并发压测、无论成败都关闭服务。
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3912;
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit'
});

const scripts = ['e2e-check.js', 'concurrency-check.js'];
let code = 0;

function waitForBoot() {
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/api/config`);
        if (res.ok) {
          clearInterval(timer);
          resolve();
        }
      } catch {}
    }, 200);
  });
}

async function run(script) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
    child.on('exit', (status) => {
      if (status) code = status;
      resolve();
    });
  });
}

(async () => {
  await waitForBoot();
  for (const script of scripts) {
    if (code) break;
    await run(script);
  }
})().finally(() => {
  server.kill();
  process.exit(code);
});
