import { Connection } from 'oracledb';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'perfFixture.sql'), 'utf8');

/** Splits a sqlplus-style script on "/" terminator lines, like test/integration/support/fixture.ts does. */
function splitBlocks(sql: string): string[] {
    return sql
        .split(/^\s*\/\s*$/m)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
}

export interface GenerateOptions {
    packages?: number;
    testsMin?: number;
    testsMax?: number;
    seed?: number;
}

/** Creates ut_perf_config and the ut_perf_gen package. Idempotent (CREATE OR REPLACE / CREATE TABLE guarded below). */
export async function installPerfFixtureObjects(conn: Connection): Promise<void> {
    try {
        await conn.execute('SELECT 1 FROM ut_perf_config WHERE ROWNUM = 1');
    } catch {
        // ORA-00942 (table or view does not exist) -- fall through and create it below.
        for (const block of splitBlocks(FIXTURE_SQL)) {
            await conn.execute(block);
        }
        return;
    }
    // Table already exists from a previous run: only (re)create the package, not
    // the table. Matched by substring rather than a `^`-anchored regex because the
    // first block also carries this file's leading comment header.
    const blocks = splitBlocks(FIXTURE_SQL).filter((b) => !b.includes('CREATE TABLE ut_perf_config'));
    for (const block of blocks) {
        await conn.execute(block);
    }
}

/** Generates (or regenerates) the UT_PERF_TEST_* packages. See perfFixture.sql's ut_perf_gen.generate() doc comment. */
export async function generatePerfFixture(conn: Connection, options: GenerateOptions = {}): Promise<void> {
    await conn.execute(
        `BEGIN
           ut_perf_gen.generate(
             p_packages  => :packages,
             p_tests_min => :testsMin,
             p_tests_max => :testsMax,
             p_seed      => :seed
           );
         END;`,
        {
            packages: options.packages ?? 1000,
            testsMin: options.testsMin ?? 10,
            testsMax: options.testsMax ?? 20,
            seed: options.seed ?? 42
        }
    );
    await conn.commit();
}

/** Drops every UT_PERF_TEST_* package. Leaves ut_perf_config/ut_perf_gen themselves in place. */
export async function dropPerfFixture(conn: Connection): Promise<void> {
    await conn.execute('BEGIN ut_perf_gen.drop_all; END;');
    await conn.commit();
}

/**
 * sleep_scale multiplier for the "slow"/"medium" duration tiers (see
 * perfFixture.sql): 0 = instant (isolates discovery/tree cost), ~0.1 = a
 * realistic spread of short delays, 1 = the full 2-10s "slow" tests.
 */
export async function setSleepScale(conn: Connection, scale: number): Promise<void> {
    await conn.execute('BEGIN ut_perf_gen.set_sleep_scale(:scale); END;', { scale });
    await conn.commit();
}

export const PERF_PACKAGE_PREFIX = 'UT_PERF_TEST_';
/** A ~5%-of-default-1000-packages suitepath, for a quick "full" (sleep_scale=1) run without regenerating the whole fixture. */
export const PERF_QUICK_SUBSET_SUITEPATH = 'perf.g00';
