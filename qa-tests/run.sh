#!/usr/bin/env bash
# QA 实证测试运行脚本（bash / Git Bash）
# 用 esbuild 把测试+源码打成单文件 bundle，alias 替换 GM 模块为 no-op 桩，再用 node 运行。
# 不改 node_modules、不影响 vite/tsc 构建。
set -e
cd "$(dirname "$0")/.."
node_modules/.bin/esbuild qa-tests/test-pure.ts --bundle --format=esm --platform=node \
  --alias:vite-plugin-monkey/dist/client=./qa-tests/gm-stub.ts --outfile=qa-tests/bundled-test.mjs
node qa-tests/bundled-test.mjs
