#!/usr/bin/env node
try {
  const { main } = await import('../dist/cli.js');
  process.exitCode = await main(process.argv.slice(2));
} catch {
  console.error('RepoProof: operation failed. Check your input and local installation.');
  process.exitCode = 2;
}
