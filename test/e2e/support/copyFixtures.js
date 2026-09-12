// esbuild inlines test/integration/support/fixture.ts's code into the
// bundled testExplorer.e2e.test.js, but its fs.readFileSync(path.join(
// __dirname, 'fixture.sql')) resolves __dirname at *runtime* against the
// bundle's own location (test/e2e/out/), not fixture.ts's original
// directory. Copying the .sql files it reads there is simpler and less
// fragile than changing fixture.ts's file-reading approach just for this
// one (bundled) consumer, when test/integration's own (unbundled, ts-node)
// use of the same file needs it to keep reading relative to itself.
const fs = require('node:fs');
const path = require('node:path');

const sourceDir = path.join(__dirname, '..', '..', 'integration', 'support');
const targetDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(targetDir, { recursive: true });

for (const file of ['fixture.sql', 'snippetsFixture.sql']) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
}
