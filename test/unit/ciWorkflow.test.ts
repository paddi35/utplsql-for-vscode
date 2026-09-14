import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * ci.yml runs `npm ci` for every pull_request, including from forks -- which
 * executes the PR author's own postinstall script plus every dependency's
 * install script on the runner. That is the normal, accepted trade-off for
 * open-source CI, and it is safe specifically because the workflow triggers
 * on `pull_request` (a fork PR gets a read-only GITHUB_TOKEN and no
 * repository secrets), not `pull_request_target` (which would hand a fork
 * PR's code write access and secrets while still checking out and running
 * it).
 *
 * Nothing else enforces that this stays true. A well-intentioned future edit
 * -- e.g. switching to pull_request_target because it makes posting a PR
 * comment easier, or adding a `secrets:` block to reach some external
 * service -- could quietly reopen this without anyone connecting the change
 * back to this finding (issue #80, which also names finding #5's
 * `permissions:` block as no longer optional once this guard stops holding).
 */
describe('ci.yml stays safe to run untrusted fork-PR install scripts in', () => {
    const CI_YML_PATH = path.resolve(process.cwd(), '.github', 'workflows', 'ci.yml');
    const ciYml = fs.readFileSync(CI_YML_PATH, 'utf8');

    it("triggers on 'pull_request', not the secrets-exposing 'pull_request_target'", () => {
        assert.match(ciYml, /^\s*pull_request:\s*$/m, "ci.yml no longer has a 'pull_request:' trigger");
        assert.doesNotMatch(
            ciYml,
            /pull_request_target/,
            "ci.yml now uses 'pull_request_target', which exposes repository secrets and a write-scoped " +
                "GITHUB_TOKEN to a fork PR whose code this workflow runs via `npm ci` -- see issue #80."
        );
    });

    it('declares no secrets for the job that runs `npm ci` against untrusted fork-PR code', () => {
        assert.doesNotMatch(
            ciYml,
            /^\s*secrets:/m,
            "ci.yml now declares a 'secrets:' block for a job that runs `npm ci` (and therefore the PR " +
                'author\'s own install scripts) on every pull_request, including from forks -- see issue #80.'
        );
    });
});
