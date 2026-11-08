// 作者：Wangyuan；日期：2026-11-08。职责：不允许启动无法完成内部采集的服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {startServer} from '../src/server.mjs';

test('单网卡绑定在创建服务前明确拒绝，localhost稳定绑定回环', async () => {
  const previous = process.env.HOST;
  try {
    process.env.HOST = '192.0.2.10';
    await assert.rejects(startServer(0), /HOST 仅支持/);
    process.env.HOST = 'localhost';
    const {server, origin} = await startServer(0);
    try {
      assert.equal(server.address().address, '127.0.0.1');
      assert.equal((await fetch(origin + '/healthz')).status, 200);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally {
    if (previous === undefined) delete process.env.HOST;
    else process.env.HOST = previous;
  }
});

test('部署默认发布回环地址，远程绑定需要显式设置', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'catalog-deploy-regression-'));
  try {
    const docker = path.join(root, 'docker'), sleep = path.join(root, 'sleep');
    await writeFile(docker, '#!/bin/bash\ncase "$1" in\ninfo) exit 0;;\ncontainer) exit 1;;\nrun) printf "%s\\n" "$@" > "$CAPTURE";;\ninspect) echo true;;\nesac\n');
    await writeFile(sleep, '#!/bin/bash\nexit 0\n');
    await chmod(docker, 0o755); await chmod(sleep, 0o755);
    const capture = path.join(root, 'args.txt');
    for (const address of [undefined, '192.0.2.15']) {
      const env = {PATH: `${root}:/usr/bin:/bin`, HOME: root, CAPTURE: capture, HOST_PORT: '54321', CONTAINER_PORT: '8080'};
      if (address) env.BIND_ADDRESS = address;
      execFileSync('/bin/bash', [fileURLToPath(new URL('../deploy.sh', import.meta.url)), 'start'], {env, timeout: 10000});
      const args = (await readFile(capture, 'utf8')).trimEnd().split('\n');
      assert.equal(args[args.indexOf('-p') + 1], `${address || '127.0.0.1'}:54321:8080`);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
