import assert from 'node:assert/strict';
import { EventOwnerResolver, firstOwner } from '../../src/testing/eventOwners';
import { SuiteItemInfo, TestItemInfo } from '../../src/model/events';

function test(id: string, ownerName: string, testNumber: number): TestItemInfo {
    return { id, ownerName, testNumber };
}

function suite(id: string, items: Array<SuiteItemInfo | TestItemInfo>): SuiteItemInfo {
    return { id, items };
}

/** Same suitepath `shared.test_pkg.t1` in two schemas, as ut_realtime_reporter emits it. */
const twoSchemas = (): SuiteItemInfo[] => [
    suite('shared', [suite('shared.test_pkg', [test('shared.test_pkg.t1', 'uta', 1)])]),
    suite('shared', [suite('shared.test_pkg', [test('shared.test_pkg.t1', 'UTB', 2)])])
];

describe('EventOwnerResolver', () => {
    it('resolves tests with identical ids by testNumber', () => {
        const r = new EventOwnerResolver(twoSchemas());
        assert.equal(r.ownerOfTest(1), 'UTA');
        assert.equal(r.ownerOfTest(2), 'UTB');
        assert.equal(r.ownerOfTest(3), undefined);
        assert.equal(r.ownerOfTest(undefined), undefined);
    });

    it('resolves suites with identical ids in stream order', () => {
        const r = new EventOwnerResolver(twoSchemas());
        assert.equal(r.startSuite('shared'), 'UTA');
        assert.equal(r.startSuite('shared.test_pkg'), 'UTA');
        assert.equal(r.endSuite('shared.test_pkg'), 'UTA');
        assert.equal(r.endSuite('shared'), 'UTA');
        assert.equal(r.startSuite('shared'), 'UTB');
        assert.equal(r.startSuite('shared.test_pkg'), 'UTB');
        assert.equal(r.endSuite('shared.test_pkg'), 'UTB');
        assert.equal(r.endSuite('shared'), 'UTB');
    });

    it('returns undefined for an unknown suite so the caller can fall back', () => {
        const r = new EventOwnerResolver(twoSchemas());
        assert.equal(r.startSuite('other'), undefined);
        assert.equal(r.endSuite('other'), undefined);
    });
});

describe('firstOwner', () => {
    it('takes the owner of the first test below a suite', () => {
        assert.equal(firstOwner(suite('s', [suite('s.p', [test('s.p.t', 'hr', 1)])])), 'HR');
    });

    it('is undefined for a suite without tests', () => {
        assert.equal(firstOwner(suite('s', [])), undefined);
    });
});
