import assert from 'node:assert/strict';
import { dedupPathList, parseId, pathId, rootId, schemaId, toRunPath } from '../../src/testing/ids';
import { validateProfileName } from '../../src/db/profileName';

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

    /**
     * Ties validateProfileName (src/db/profileName.ts, issue #25) to this
     * file's own id-encoding scheme, rather than to a guess: a profile name
     * becomes part of every TestItem.id, so the property that actually
     * matters is that every name the validator accepts survives being
     * round-tripped through it. This is the property the '/' and ':' bans
     * exist to protect — see profileName.ts's doc comment for why those two
     * characters specifically.
     */
    describe('validateProfileName round-trips with the TestItem id scheme', () => {
        const acceptedNames = ['dev', 'DEV_1', 'my-profile', 'my.profile', 'name with spaces', 'a@b'];

        it('accepts every candidate name (sanity check before round-tripping it)', () => {
            for (const name of acceptedNames) {
                assert.equal(validateProfileName(name), undefined, `expected '${name}' to be accepted`);
            }
        });

        it('round-trips every accepted name through rootId', () => {
            for (const name of acceptedNames) {
                assert.deepEqual(parseId(rootId(name)), { kind: 'root', profile: name });
            }
        });

        it('round-trips every accepted name through pathId, preserving owner and suitepath', () => {
            for (const name of acceptedNames) {
                const id = pathId(name, 'HR', 'suite1.test1');
                assert.deepEqual(parseId(id), { kind: 'path', profile: name, owner: 'HR', suitepath: 'suite1.test1' });
            }
        });

        it('rejects the two characters that would break the round trip', () => {
            assert.notEqual(validateProfileName('a/b'), undefined);
            assert.notEqual(validateProfileName('a:b'), undefined);
        });

        it('demonstrates the actual round-trip failure a banned "/" causes if it were ever let through', () => {
            const brokenId = rootId('a/b');
            assert.throws(() => parseId(brokenId), /cannot parse TestItem id/);
        });
    });
});
