#!/usr/bin/env node
import { runFeishuSendCli } from '../dist/src/unified/feishu-send-cli.js';

process.exitCode = await runFeishuSendCli(process.argv.slice(2));
