const baseUrl = String(process.env.STAGING_URL || process.argv[2] || '').replace(/\/$/, '');

if (!baseUrl) {
  console.error('Usage: STAGING_URL=https://example.com npm run check:staging');
  process.exit(1);
}

for (const path of ['/api/health', '/api/ready']) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${body}`);
  }
  console.log(`${path}: ${body}`);
}
