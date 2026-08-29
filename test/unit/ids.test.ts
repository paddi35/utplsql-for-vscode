import assert from 'node:assert/strict';
import { dedupPathList, parseId, pathId, rootId, schemaId, toRunPath } from '../../src/testing/ids';

describe('ids', () => {
    it('builds and parses root/schema/path ids', () => {
        assert.equal(rootId('DEV'), 'conn:DEV');
        assert.equal(schemaId('DEV', 'hr'), 'conn:DEV/schema:HR');
        const id = pathId('DEV', 'hr', 'suite1.test1');
        assert.equal(id, 'conn:DEV/path:HR:suite1.test1');

        assert.deepEqual(parseId('conn:DEV'), { kind: 'root', profile: 'DEV' });
        assert.deepEqual(parseId('conn:DEV/schema:HR'), { kind: 'schema', profile: 'DEV', owner: 'HR' });
        assert.deepEqual(parseId(id), { kind: 'path', profile: 'DEV', owner: 'HR', suitepath: 'suite1.test1' });
    });

    it('builds the OWNER:suitepath run path from a path id', () => {
        const id = pathId('DEV', 'hr', 'suite1.test1');
        assert.equal(toRunPath(id), 'HR:suite1.test1');
    });

    it('drops a selected test that is already covered by its selected suite', () => {
        const result = dedupPathList([
            { owner: 'HR', suitepath: 'suite1' },
            { owner: 'HR', suitepath: 'suite1.test1' },
            { owner: 'HR', suitepath: 'suite1.test2' }
        ]);
        assert.deepEqual(result, [{ owner: 'HR', suitepath: 'suite1' }]);
    });

    it('keeps paths from different owners even with the same suitepath', () => {
        const result = dedupPathList([
            { owner: 'HR', suitepath: 'suite1' },
            { owner: 'SCOTT', suitepath: 'suite1' }
        ]);
        assert.equal(result.length, 2);
    });

    it('keeps siblings that do not overlap', () => {
        const result = dedupPathList([
            { owner: 'HR', suitepath: 'suite1.test1' },
            { owner: 'HR', suitepath: 'suite2.test1' }
        ]);
        assert.equal(result.length, 2);
    });

    it('does not treat a same-prefixed sibling suite as covered', () => {
        // "suite1x" must not be considered a child of "suite1".
        const result = dedupPathList([
            { owner: 'HR', suitepath: 'suite1' },
            { owner: 'HR', suitepath: 'suite1x' }
        ]);
        assert.equal(result.length, 2);
    });
});
