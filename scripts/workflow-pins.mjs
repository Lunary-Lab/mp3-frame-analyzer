import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { parseDocument } from 'yaml';

const pinAudits = new Set(['unpinned-uses', 'unpinned-images']);

export async function collectWorkflowInputs(root) {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, 'Cannot discover repository workflow inputs');
  const files = [...new Set(result.stdout.split('\0'))]
    .filter(
      (file) => /^\.github\/workflows\/.+\.ya?ml$/.test(file) || /(^|\/)action\.ya?ml$/.test(file),
    )
    .sort();
  assert.ok(files.length > 0, 'No workflow or action inputs');
  for (const file of files) {
    assert.ok((await lstat(join(root, file))).isFile(), `Expected a regular file: ${file}`);
    assert.equal(
      await realpath(join(root, file)),
      resolve(root, file),
      `Symlinked source path: ${file}`,
    );
  }
  return files;
}

function inspectSteps(steps, file, locals) {
  for (const step of steps ?? []) {
    assert.ok(
      !String(step?.uses ?? '').startsWith('docker://'),
      `${file}: Docker action acquisition needs an explicitly reviewed integrity policy`,
    );
    if (String(step?.uses ?? '').startsWith('./')) locals.push({ target: step.uses, action: true });
    if (step?.parallel) inspectSteps(step.parallel, file, locals);
  }
}

/** Native YAML parsing resolves aliases; no regex attempts to interpret workflow syntax. */
export function requireSupportedWorkflow(source, file) {
  const locals = [];
  const document = parseDocument(source, { uniqueKeys: true, merge: true });
  assert.equal(document.errors.length, 0, `${file}: malformed YAML`);
  assert.equal(document.warnings.length, 0, `${file}: unsupported YAML feature`);
  const value = document.toJS({ maxAliasCount: 100 });
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${file}: expected mapping`,
  );
  assert.notEqual(
    value.runs?.using,
    'docker',
    `${file}: Docker actions require explicit integrity review`,
  );
  inspectSteps(value.runs?.steps, file, locals);
  for (const job of Object.values(value.jobs ?? {})) {
    assert.ok(!('container' in job), `${file}: job containers require explicit integrity review`);
    assert.ok(
      !('services' in job),
      `${file}: service containers require explicit integrity review`,
    );
    inspectSteps(job.steps, file, locals);
    if (String(job.uses ?? '').startsWith('./')) locals.push({ target: job.uses, action: false });
  }
  return locals;
}

export function requireSourceBoundLocals(locals, files) {
  for (const { target, action } of locals) {
    assert.ok(!target.includes('\\'), 'Local references must use portable forward-slash paths');
    const relative = target.slice(2) || '.';
    assert.ok(
      posix.normalize(relative) === relative && relative !== '..' && !relative.startsWith('../'),
      'Local reference must stay inside repository source',
    );
    const candidates = action
      ? ['action.yml', 'action.yaml'].map((name) => posix.join(relative, name))
      : [relative];
    assert.equal(
      candidates.filter((file) => files.includes(file)).length,
      1,
      `Local reference needs one discovered source target: ${target}`,
    );
    if (!action)
      assert.match(
        relative,
        /^\.github\/workflows\/.+\.ya?ml$/,
        'Local reusable workflow must be repository source',
      );
  }
}

export function requirePinnedFindings(status, output) {
  assert.ok([0, 11, 12, 13, 14].includes(status), 'Scanner did not complete a successful audit');
  const findings = JSON.parse(output);
  assert.ok(Array.isArray(findings), 'Missing zizmor finding inventory');
  for (const finding of findings)
    assert.ok(
      finding && typeof finding.ident === 'string' && finding.ignored === false,
      'Malformed or ignored zizmor finding',
    );
  assert.equal(status === 0, findings.length === 0, 'Inconsistent scanner status and evidence');
  const violations = findings.filter((finding) => pinAudits.has(finding.ident));
  assert.equal(
    violations.length,
    0,
    `Unpinned workflow dependencies: ${violations.map((finding) => finding.ident).join(', ')}`,
  );
  return findings.length;
}

export async function auditWorkflowPins(binary, root, cache) {
  const files = await collectWorkflowInputs(root);
  for (const file of files) {
    const locals = requireSupportedWorkflow(await readFile(join(root, file), 'utf8'), file);
    requireSourceBoundLocals(locals, files);
  }
  const result = spawnSync(
    binary,
    [
      '--offline',
      '--strict-collection',
      '--no-config',
      '--no-ignores',
      '--persona=auditor',
      '--format=json',
      '--no-progress',
      '--cache-dir',
      cache,
      '--',
      ...files,
    ],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(result.error, undefined, 'zizmor execution failed');
  const otherFindings = requirePinnedFindings(result.status, result.stdout);
  return { inputs: files.length, otherFindings };
}
