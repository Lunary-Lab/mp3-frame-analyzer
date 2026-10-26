import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditWorkflowPins } from './workflow-pins.mjs';

const commit = 'a'.repeat(40);
const workflow = (uses) =>
  'name: Pin control\non: push\npermissions: {}\njobs:\n  probe:\n' +
  `    runs-on: ubuntu-24.04\n    steps:\n      - uses: ${uses}\n`;
const composite = (uses) =>
  `name: Pin control\ndescription: Pin control\nruns:\n  using: composite\n  steps:\n    - uses: ${uses}\n`;
const reusable = (uses) =>
  `name: Pin control\non: push\npermissions: {}\njobs:\n  probe:\n    uses: ${uses}\n`;

/** Exercise the installed native scanner, not a mock or a replica of its rules. */
export async function workflowPinControls(binary, cache) {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-native-workflow-pins-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    const file = join(directory, '.github/workflows/control.yml');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, workflow(`example/action@${commit}`));
    assert.equal((await auditWorkflowPins(binary, directory, cache)).inputs, 1);
    await mkdir(join(directory, 'local'));
    await writeFile(join(directory, 'local/action.yml'), composite(`example/action@${commit}`));
    await writeFile(file, workflow('./local'));
    assert.equal((await auditWorkflowPins(binary, directory, cache)).inputs, 2);
    await rm(join(directory, 'local'), { recursive: true });
    await assert.rejects(auditWorkflowPins(binary, directory, cache), /discovered source target/);
    for (const uses of [
      'actions/checkout@v7',
      'example/action@main',
      `example/action@${commit.slice(0, 7)}`,
      'example/action@${{ inputs.ref }}',
      'example/action',
      'example/action@v1 # zizmor: ignore[unpinned-uses]',
    ]) {
      await writeFile(file, workflow(uses));
      await assert.rejects(auditWorkflowPins(binary, directory, cache), undefined, uses);
    }
    await writeFile(file, reusable(`example/repo/.github/workflows/reuse.yml@${commit}`));
    await auditWorkflowPins(binary, directory, cache);
    await writeFile(file, reusable('example/repo/.github/workflows/reuse.yml@v1'));
    await assert.rejects(auditWorkflowPins(binary, directory, cache), /unpinned-uses/);
    await writeFile(file, workflow(`example/action@${commit}`));
    const added = join(directory, 'new directory/action.yaml');
    await mkdir(dirname(added));
    await writeFile(added, composite(`example/action@${commit}`));
    assert.equal((await auditWorkflowPins(binary, directory, cache)).inputs, 2);
    await writeFile(added, composite('example/action@v1'));
    await assert.rejects(auditWorkflowPins(binary, directory, cache), /unpinned-uses/);
    await writeFile(added, composite('docker://alpine:3'));
    await assert.rejects(auditWorkflowPins(binary, directory, cache), /integrity policy/);
    await writeFile(added, 'runs: [');
    await assert.rejects(auditWorkflowPins(binary, directory, cache), /malformed YAML/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
