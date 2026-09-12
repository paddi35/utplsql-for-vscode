import assert from 'node:assert/strict';
import { pickTnsAdminDir } from '../../src/db/tnsAdminDir';

describe('pickTnsAdminDir', () => {
    it('uses the own machine-scoped setting when set, ignoring every other source', () => {
        const result = pickTnsAdminDir({
            own: '/own/dir',
            sqldevInspect: { globalValue: '/sqldev/global', workspaceValue: '/sqldev/workspace' },
            envTnsAdmin: '/env/dir'
        });
        assert.deepEqual(result, { dir: '/own/dir', source: 'own' });
    });

    it('falls back to the SQL Developer setting when it is present only as a global value', () => {
        const result = pickTnsAdminDir({
            own: undefined,
            sqldevInspect: { globalValue: '/sqldev/global' },
            envTnsAdmin: undefined
        });
        assert.deepEqual(result, { dir: '/sqldev/global', source: 'sqldeveloper' });
    });

    it('ignores a SQL Developer value that exists only as a workspace value, falling through to TNS_ADMIN', () => {
        // Regression guard for issue #12: sqldeveloper.connections.tnsConfiguration.path
        // belongs to a different extension, whose declared scope this
        // extension does not control. A workspace's own .vscode/settings.json
        // can set it, and the resulting directory used to be handed straight
        // to oracledb's configDir — silently redirecting a credentialed
        // connection's tnsnames.ora lookup at whatever the workspace chose.
        const result = pickTnsAdminDir({
            own: undefined,
            sqldevInspect: { workspaceValue: '/sqldev/workspace' },
            envTnsAdmin: '/env/dir'
        });
        assert.deepEqual(result, { dir: '/env/dir', source: 'env' });
    });

    it('prefers the SQL Developer global value over a workspace value when both are present', () => {
        const result = pickTnsAdminDir({
            own: undefined,
            sqldevInspect: { globalValue: '/sqldev/global', workspaceValue: '/sqldev/workspace' },
            envTnsAdmin: undefined
        });
        assert.deepEqual(result, { dir: '/sqldev/global', source: 'sqldeveloper' });
    });

    it('resolves to undefined when nothing is set anywhere', () => {
        // pool.ts's getPool() spreads configDir into createPool() only when
        // it is truthy (`...(configDir ? { configDir } : {})`), so this
        // return value is what makes createPool() run without a configDir
        // at all rather than with an empty one.
        const result = pickTnsAdminDir({ own: undefined, sqldevInspect: undefined, envTnsAdmin: undefined });
        assert.deepEqual(result, { dir: undefined, source: 'none' });
    });

    it('falls back to a SQL Developer default value the same way as a global one', () => {
        const result = pickTnsAdminDir({
            own: undefined,
            sqldevInspect: { defaultValue: '/sqldev/default', workspaceValue: '/sqldev/workspace' },
            envTnsAdmin: undefined
        });
        assert.deepEqual(result, { dir: '/sqldev/default', source: 'sqldeveloper' });
    });

    it('falls through when the own setting is an empty string rather than undefined', () => {
        // get<string>() on an unset machine-scoped setting returns
        // package.json's declared default (""), not undefined — this pins
        // that the empty-string case is treated as "unset", same as the
        // pre-existing behaviour for the own setting.
        const result = pickTnsAdminDir({ own: '', sqldevInspect: { globalValue: '/sqldev/global' }, envTnsAdmin: undefined });
        assert.deepEqual(result, { dir: '/sqldev/global', source: 'sqldeveloper' });
    });
});
