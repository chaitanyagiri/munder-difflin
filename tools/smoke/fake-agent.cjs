#!/usr/bin/env node
'use strict';

const mode = process.env.MUNDER_FAKE_AGENT_MODE || 'ack';

console.log(`FAKE_AGENT_READY mode=${mode}`);
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    console.log(`FAKE_AGENT_INPUT ${line}`);
    if (/closing time/i.test(line)) {
      if (mode === 'no-ack') {
        console.log('FAKE_AGENT_NO_ACK');
      } else {
        console.log('CLOSING-TIME-ACK');
      }
      continue;
    }
    if (/exit/i.test(line)) {
      console.log('FAKE_AGENT_EXIT');
      process.exit(0);
    }
    console.log(`FAKE_AGENT_WORK_ORDER ${line}`);
  }
});
