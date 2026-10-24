import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { buildApp } from '../dist/app.js';

if (!process.send) throw new Error('Start this benchmark server through http-performance.mjs');
const app = await buildApp();
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let baseline = performance.eventLoopUtilization();
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.send({ type: 'ready', address });

process.on('message', async (message) => {
  if (message === 'measure') {
    histogram.reset();
    baseline = performance.eventLoopUtilization();
    process.send({ type: 'measuring' });
    return;
  }
  if (message !== 'stop') throw new Error('Unknown benchmark server message');
  await app.close();
  histogram.disable();
  process.send({
    type: 'metrics',
    eventLoopUtilization: performance.eventLoopUtilization(baseline),
    eventLoopDelayMs: {
      samples: histogram.count,
      mean: histogram.count > 0 ? histogram.mean / 1e6 : null,
      p99: histogram.count > 0 ? histogram.percentile(99) / 1e6 : null,
      max: histogram.count > 0 ? histogram.max / 1e6 : null,
    },
    memoryBytes: process.memoryUsage(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  });
  process.disconnect();
});
