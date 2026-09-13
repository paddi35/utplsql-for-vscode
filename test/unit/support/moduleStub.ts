import Module from 'node:module';
import * as path from 'node:path';

/**
 * Injects a fake module for `request` into Node's require cache, so source
 * files that do `import ... from request` resolve to `exportsValue`
 * instead. Needed for src/db/connections.ts (and anything importing it,
 * like src/db/pool.ts and src/testing/controller.ts): 'vscode' only exists
 * inside the real extension host, so plain mocha/ts-node cannot load those
 * files at all otherwise — every other vscode-importing file in this
 * codebase is instead left untested at the unit level, with its pure logic
 * extracted into its own vscode-free module (see perf.test.ts,
 * runLogging.test.ts) — but connections.ts's only real runtime use of
 * vscode is workspace.getConfiguration()'s get/update/inspect, which is
 * simple enough to fake directly (see fakeVscode.ts), and pool.ts's own
 * closePool/getPool caching behaviour (issue #19) is worth exercising for
 * real rather than only through an extracted pure fragment.
 *
 * Cast to `any` throughout: `_cache`/`_resolveFilename` are long-standing
 * but untyped Node internals (see @types/node's module.d.ts, which doesn't
 * declare them) — the same mechanism tools like proxyquire/mock-require use
 * to fake an otherwise-unresolvable module.
 */
export function installModuleStub(request: string, exportsValue: unknown): { uninstall(): void } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ModuleAny = Module as any;
    const stubId = `\0utplsql-test-stub:${request}`;
    const original = ModuleAny._resolveFilename;
    ModuleAny._resolveFilename = function (thisRequest: string, ...rest: unknown[]) {
        if (thisRequest === request) {
            return stubId;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return original.call(this, thisRequest, ...(rest as any[]));
    };
    ModuleAny._cache[stubId] = { id: stubId, filename: stubId, loaded: true, exports: exportsValue };

    return {
        uninstall() {
            ModuleAny._resolveFilename = original;
            delete ModuleAny._cache[stubId];
        }
    };
}

/** Drops `modulePath` (from require.resolve(...)) from require.cache so the next require() re-evaluates it under whatever stubs are currently installed. */
export function uncache(modulePath: string): void {
    delete require.cache[modulePath];
}

/**
 * Drops every currently-cached module under this project's src/ tree —
 * including ones the caller never named — from require.cache. Needed
 * because a module's `import * as vscode from 'vscode'` binds to whichever
 * fake was installed the *first* time that module was require()'d in this
 * mocha process; naming only the module directly under test (e.g.
 * commands/index.ts) and forgetting one of its transitive dependencies
 * (connections.ts, pool.ts, tnsnames.ts, …) leaves that dependency silently
 * bound to a stale fake from an earlier test file, reading and writing a
 * `store`/`messages` object no longer reachable from the current test.
 * Uncaching the whole src/ tree side-steps having to enumerate the import
 * graph by hand and keep it in sync as it changes.
 */
export function uncacheAllSrcModules(): void {
    const marker = `${path.sep}src${path.sep}`;
    for (const key of Object.keys(require.cache)) {
        if (key.includes(marker)) {
            delete require.cache[key];
        }
    }
}
