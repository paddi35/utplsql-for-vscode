/**
 * Standalone CLI for the performance fixture (see docs/performance.md),
 * independent of running the mocha perf suite -- lets you generate the
 * fixture once, dial sleep_scale up/down for a "tree"/"mixed"/"full" run
 * (see perfFixture.sql's header comment), or tear it down, against
 * whatever local DB test/integration/support/db.ts already points at.
 *
 * Usage: ts-node test/perf/support/cli.ts <generate|scale|drop> [args...]
 *   generate [packages] [testsMin] [testsMax] [seed]   (defaults: 1000 10 20 42)
 *   scale <0-1>                                        (0 = instant, 1 = full 2-10s tests)
 *   drop
 */
import { getTestConnection, closeTestPool } from '../../integration/support/db';
import { installPerfFixtureObjects, generatePerfFixture, dropPerfFixture, setSleepScale } from './perfFixture';

async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    const conn = await getTestConnection();
    try {
        switch (command) {
            case 'generate': {
                const [packages, testsMin, testsMax, seed] = args.map((a) => (a !== undefined ? Number(a) : undefined));
                await installPerfFixtureObjects(conn);
                const start = Date.now();
                await generatePerfFixture(conn, { packages, testsMin, testsMax, seed });
                console.log(`Generated ${packages ?? 1000} package(s) in ${Date.now() - start}ms.`);
                break;
            }
            case 'scale': {
                const scale = Number(args[0]);
                if (Number.isNaN(scale)) {
                    throw new Error('Usage: cli.ts scale <number, e.g. 0 or 0.1 or 1>');
                }
                await setSleepScale(conn, scale);
                console.log(`sleep_scale set to ${scale}.`);
                break;
            }
            case 'drop': {
                await dropPerfFixture(conn);
                console.log('Dropped all UT_PERF_TEST_* packages.');
                break;
            }
            default:
                throw new Error(`Usage: cli.ts <generate|scale|drop> [args...] (got '${command ?? ''}')`);
        }
    } finally {
        await conn.close();
        await closeTestPool();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
