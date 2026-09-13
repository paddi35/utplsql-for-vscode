import assert from 'node:assert/strict';
import { candidateLabel, Candidate, chooseTarget, editorTargetFromVirtualSource, targetFromDiscoveryRow } from '../../src/commands/resolveTarget';

/** Fails the test if called — asserts a code path that must resolve without ever prompting. */
function pickOneMustNotBeCalled(): (labels: string[]) => Promise<string | undefined> {
    return async (labels) => {
        throw new Error(`pickOne should not have been called, but was, with labels: ${JSON.stringify(labels)}`);
    };
}

describe('chooseTarget', () => {
    it('returns the editor target and never prompts, even when candidates are also present', () => {
        const editorTarget: Candidate = { owner: 'HR', packageName: 'TEST_EMPLOYEES', procedureName: 'test_hire' };
        const candidates: Candidate[] = [{ owner: 'HR', packageName: 'TEST_OTHER' }];
        return chooseTarget({ editorTarget, candidates, pickOne: pickOneMustNotBeCalled() }).then((result) => {
            assert.deepEqual(result, editorTarget);
        });
    });

    it('chooses the single candidate without prompting when there is no editor target', async () => {
        const only: Candidate = { owner: 'HR', packageName: 'TEST_EMPLOYEES' };
        const result = await chooseTarget({ candidates: [only], pickOne: pickOneMustNotBeCalled() });
        assert.deepEqual(result, only);
    });

    it('offers the distinct OWNER.OBJECT[.PROCEDURE] set, sorted, when there is no editor target and several candidates', async () => {
        const candidates: Candidate[] = [
            { owner: 'HR', packageName: 'TEST_EMPLOYEES', procedureName: 'test_hire' },
            { owner: 'HR', packageName: 'TEST_EMPLOYEES', procedureName: 'test_hire' }, // duplicate of the row above
            { owner: 'HR', packageName: 'TEST_DEPARTMENTS' },
            { owner: 'FINANCE', packageName: 'TEST_BUDGET' }
        ];
        let seenLabels: string[] | undefined;
        const result = await chooseTarget({
            candidates,
            pickOne: async (labels) => {
                seenLabels = labels;
                return 'HR.TEST_DEPARTMENTS';
            }
        });
        assert.deepEqual(seenLabels, ['FINANCE.TEST_BUDGET', 'HR.TEST_DEPARTMENTS', 'HR.TEST_EMPLOYEES.test_hire']);
        assert.deepEqual(result, { owner: 'HR', packageName: 'TEST_DEPARTMENTS' });
    });

    it('returns undefined and performs no further work when the QuickPick is cancelled', async () => {
        const candidates: Candidate[] = [{ owner: 'HR', packageName: 'A' }, { owner: 'HR', packageName: 'B' }];
        const result = await chooseTarget({ candidates, pickOne: async () => undefined });
        assert.equal(result, undefined);
    });

    it('returns undefined when there is no editor target and no candidates at all', async () => {
        const result = await chooseTarget({ candidates: [], pickOne: pickOneMustNotBeCalled() });
        assert.equal(result, undefined);
    });
});

describe('candidateLabel', () => {
    it('is OWNER.PACKAGE for a package-level candidate', () => {
        assert.equal(candidateLabel({ owner: 'HR', packageName: 'TEST_EMPLOYEES' }), 'HR.TEST_EMPLOYEES');
    });

    it('is OWNER.PACKAGE.PROCEDURE for a candidate narrowed to one test', () => {
        assert.equal(candidateLabel({ owner: 'HR', packageName: 'TEST_EMPLOYEES', procedureName: 'test_hire' }), 'HR.TEST_EMPLOYEES.test_hire');
    });
});

describe('editorTargetFromVirtualSource', () => {
    it('takes owner and package name from the URI parts rather than any profile default', () => {
        const target = editorTargetFromVirtualSource({ owner: 'FINANCE', name: 'TEST_BUDGET' }, undefined);
        assert.deepEqual(target, { owner: 'FINANCE', packageName: 'TEST_BUDGET', procedureName: undefined });
    });

    it('takes the procedure name from the cursor path within the document, when the cursor sits on one', () => {
        const target = editorTargetFromVirtualSource({ owner: 'FINANCE', name: 'TEST_BUDGET' }, 'TEST_BUDGET.test_approve');
        assert.deepEqual(target, { owner: 'FINANCE', packageName: 'TEST_BUDGET', procedureName: 'test_approve' });
    });

    it('leaves procedureName undefined when the cursor path names only the package', () => {
        const target = editorTargetFromVirtualSource({ owner: 'FINANCE', name: 'TEST_BUDGET' }, 'TEST_BUDGET');
        assert.deepEqual(target, { owner: 'FINANCE', packageName: 'TEST_BUDGET', procedureName: undefined });
    });
});

/**
 * The Test Explorer context menu hands the clicked item's discovery row to
 * these commands, so they act on what was right-clicked instead of prompting
 * for it again (issue #29's follow-up). The two "no object" cases matter as
 * much as the positive ones: returning a wrong guess there would run or
 * export something the user never picked.
 */
describe('targetFromDiscoveryRow', () => {
    const suiteRow = {
        objectOwner: 'ut3',
        objectName: 'TEST_CALC_PKG',
        itemName: 'TEST_CALC_PKG',
        itemType: 'UT_SUITE' as const
    };

    it('resolves a suite row to its package, with no procedure', () => {
        assert.deepEqual(targetFromDiscoveryRow(suiteRow), {
            owner: 'UT3',
            packageName: 'TEST_CALC_PKG',
            procedureName: undefined
        });
    });

    it('resolves a test row to the package plus that one test', () => {
        assert.deepEqual(
            targetFromDiscoveryRow({ ...suiteRow, itemName: 'TEST_ADD', itemType: 'UT_TEST' }),
            { owner: 'UT3', packageName: 'TEST_CALC_PKG', procedureName: 'TEST_ADD' }
        );
    });

    it('resolves a context row to the whole package, since it names no single test', () => {
        assert.deepEqual(
            targetFromDiscoveryRow({ ...suiteRow, itemName: 'NESTED_CONTEXT_#1', itemType: 'UT_SUITE_CONTEXT' }),
            { owner: 'UT3', packageName: 'TEST_CALC_PKG', procedureName: undefined }
        );
    });

    it('resolves a --%suitepath grouping node to nothing, so the caller prompts instead of guessing a package', () => {
        assert.equal(
            targetFromDiscoveryRow({ ...suiteRow, objectName: '', itemName: 'a', itemType: 'UT_LOGICAL_SUITE' }),
            undefined
        );
    });

    it('resolves a row without an object name to nothing even when its type looks actionable', () => {
        assert.equal(targetFromDiscoveryRow({ ...suiteRow, objectName: '' }), undefined);
    });

    it('upper-cases the owner, so the target matches what the rest of the command layer expects', () => {
        assert.equal(targetFromDiscoveryRow({ ...suiteRow, objectOwner: 'hr' })?.owner, 'HR');
    });
});
