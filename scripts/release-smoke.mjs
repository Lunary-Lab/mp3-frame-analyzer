import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildScenarios } from './release-smoke-cases.mjs';
import { loadSmokeFixtures } from './release-smoke-fixtures.mjs';
import { sendRequest, verifyResponse, verifyKeepAlive } from './release-smoke-http.mjs';
import {
  launchRuntime,
  waitUntilReady,
  stopRuntime,
  cleanupRuntime,
} from './release-smoke-process.mjs';

export async function smokeRuntime(runtimeDirectory) {
  const fixtures = await loadSmokeFixtures();
  const scenarios = buildScenarios(fixtures);
  const runtime = await launchRuntime(runtimeDirectory);
  let livenessChecks = 0;
  let context = 'startup';
  try {
    await waitUntilReady(runtime);
    const probe = scenarios.find((scenario) => scenario.id === 'cbr/raw/default');
    assert.ok(probe, 'Known liveness fixture must be present');
    for (const scenario of scenarios) {
      context = scenario.id;
      const response = await sendRequest(runtime.baseUrl, scenario);
      verifyResponse(response, scenario.expected, scenario.id);
      assert.equal(runtime.state.exited, false, `${scenario.id}: server exited`);
      if (scenario.expected.status !== 200) {
        context = `${scenario.id}: liveness`;
        verifyResponse(
          await sendRequest(runtime.baseUrl, probe),
          probe.expected,
          `${scenario.id}: liveness`,
        );
        livenessChecks++;
      }
    }
    const rejected = scenarios.find((scenario) => scenario.id === 'multipart/wrong-mime');
    assert.ok(rejected, 'Keep-alive rejection scenario must be present');
    context = 'keep-alive multipart/wrong-mime -> cbr/raw/default';
    await verifyKeepAlive(runtime.baseUrl, rejected, probe);
    context = 'graceful shutdown';
    const shutdownExitCode = await stopRuntime(runtime);
    return {
      frameCount: 32,
      shutdownExitCode,
      scenarios: scenarios.length,
      livenessChecks,
      keepAliveRecovery: true,
    };
  } catch (error) {
    throw new Error(
      `${context}: ${error.message}\nPackaged server output (last 16384 characters):\n${runtime.state.output}`,
      { cause: error },
    );
  } finally {
    await cleanupRuntime(runtime);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    3,
    'Usage: node scripts/release-smoke.mjs <extracted-runtime-directory>',
  );
  console.log(JSON.stringify(await smokeRuntime(process.argv[2]), null, 2));
}
