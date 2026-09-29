import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

const module = await import('../src/redact.ts').catch(() => ({}));

// Synthetic PEM delimiters keep fake test material distinct from real keys.
const privateKeyBegin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const rsaPrivateKeyBegin = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');

test('redactText masks token, credential and personal-path formats', () => {
  assert.equal(typeof module.redactText, 'function', 'redactText must be implemented');
  const root = 'C:\\projects\\fake-repo';
  const input = [
    'Authorization: Bearer FAKE_BEARER_VALUE',
    'token=FAKE_ASSIGNMENT_VALUE secret: "FAKE_SECRET_VALUE"',
    'password=FAKE_PASSWORD_VALUE api_key=FAKE_API_VALUE',
    'https://fake-user:FAKE_URL_PASSWORD@example.invalid/path',
    'ghp_FAKE_TOKEN_12345678901234567890 sk-proj-FAKE_TOKEN_VALUE',
    'contact fake.person@example.invalid',
    root + '\\src\\main.ts',
    homedir() + '/private/file',
    'C:\\Users\\FakePerson\\private.txt /home/fake-person/private.txt',
  ].join('\n');
  const output = module.redactText(input, root);
  for (const secret of ['FAKE_', 'fake-user:', 'fake.person@', 'FakePerson', 'fake-person', root, homedir()]) {
    assert.ok(!output.includes(secret), `must mask ${secret.startsWith('FAKE') ? 'fake secret' : 'personal metadata'}`);
  }
  assert.ok(output.includes('<repo>'));
  assert.ok(output.includes('src\\main.ts'));
});

test('redactText removes complete and truncated private keys and partial tokens', () => {
  assert.equal(typeof module.redactText, 'function', 'redactText must be implemented');
  for (const input of [
    'before\n' + privateKeyBegin + '\nFAKE_PRIVATE_MATERIAL\n-----END PRIVATE KEY-----\nafter',
    'before\n' + rsaPrivateKeyBegin + '\nFAKE_PARTIAL_MATERIAL',
    'Bearer FAKE_PARTIAL', 'ghp_FAKE_PARTIAL', 'sk-FAKE_PARTIAL',
  ]) {
    assert.ok(!module.redactText(input).includes('FAKE_'));
  }
  assert.match(module.redactText('ordinary text\n' + privateKeyBegin + '\nFAKE_VALUE'), /^ordinary text/);
  assert.equal(module.redactText('ordinary public message'), 'ordinary public message');
});

test('redactCommand masks separated and inline secret arguments without mutation', () => {
  assert.equal(typeof module.redactCommand, 'function', 'redactCommand must be implemented');
  const command = ['node', '--token', 'FAKE_TOKEN_VALUE', '--api-key=FAKE_API_VALUE', '--token=FAKE multi word secret', '--password', 'FAKE_PASSWORD_VALUE', '--secret', 'FAKE_SECRET_VALUE', 'literal&|$"text'];
  const original = [...command];
  const output = module.redactCommand(command);
  assert.deepEqual(command, original);
  assert.equal(output.length, command.length);
  assert.ok(!output.join(' ').includes('FAKE_'));
  assert.ok(!output.join(' ').includes('multi word secret'));
  assert.equal(output.at(-1), 'literal&|$"text');
});

test('redactText masks AWS secret-access-key and session-token standard assignments and JSON', () => {
  assert.equal(typeof module.redactText, 'function');
  const output = module.redactText('AWS_SECRET_ACCESS_KEY=FAKE_AWS_SECRET_VALUE\n{"aws_secret_access_key":"FAKE_AWS_JSON_VALUE","AWS_SESSION_TOKEN":"FAKE_SESSION_TOKEN_VALUE"}');
  for (const value of ['FAKE_AWS_SECRET_VALUE', 'FAKE_AWS_JSON_VALUE', 'FAKE_SESSION_TOKEN_VALUE']) assert.ok(!output.includes(value));
});

test('redactCommand masks AWS secret-access-key and session-token flags', () => {
  assert.equal(typeof module.redactCommand, 'function');
  const command = ['node', '--aws-secret-access-key', 'FAKE_AWS_SECRET_VALUE', '--aws-secret-access-key=FAKE_AWS_INLINE_VALUE', '--aws-session-token', 'FAKE_SESSION_TOKEN_VALUE'];
  assert.ok(!module.redactCommand(command).join(' ').includes('FAKE_'));
  assert.equal(command[2], 'FAKE_AWS_SECRET_VALUE');
});
