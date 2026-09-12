import assert from 'node:assert/strict';
import { REPORT_CSP, withContentSecurityPolicy } from '../../src/testing/coverageHtml';

describe('withContentSecurityPolicy', () => {
    it('inserts the CSP meta tag immediately after <head>', () => {
        const html = '<html><head><title>x</title></head><body>hi</body></html>';
        const result = withContentSecurityPolicy(html);
        assert.equal(
            result,
            `<html><head><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><title>x</title></head><body>hi</body></html>`
        );
    });

    it('prepends the CSP meta tag when the report has no <head>', () => {
        const html = '<body>hi</body>';
        const result = withContentSecurityPolicy(html);
        assert.equal(result, `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><body>hi</body>`);
    });

    it("removes a Content-Security-Policy meta tag the report already carries, so ours is the only one present", () => {
        const html = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src *"><title>x</title></head></html>';
        const result = withContentSecurityPolicy(html);
        assert.ok(!result.includes('script-src *'), `expected the report's own policy content to be gone, got ${result}`);
        assert.equal(
            (result.match(/http-equiv="Content-Security-Policy"/gi) ?? []).length,
            1,
            `expected exactly one CSP meta tag, got ${result}`
        );
    });

    it('removes a competing CSP meta tag without disturbing an unrelated one', () => {
        const html = '<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src *"></head></html>';
        const result = withContentSecurityPolicy(html);
        assert.ok(result.includes('<meta charset="utf-8">'), `expected the charset meta tag to survive untouched, got ${result}`);
        assert.equal(
            (result.match(/http-equiv="Content-Security-Policy"/gi) ?? []).length,
            1,
            `expected exactly one CSP meta tag, got ${result}`
        );
    });

    it('removes a competing CSP meta tag regardless of attribute order or quote style', () => {
        // content before http-equiv, and no quotes around the http-equiv value at all --
        // both are legal HTML the report is free to emit even though the reporter today
        // only ever seems to produce the double-quoted, http-equiv-first form.
        const reordered = withContentSecurityPolicy('<head><meta content="script-src *" http-equiv="Content-Security-Policy"></head>');
        assert.ok(!reordered.includes('script-src *'), `expected reordered attributes to still be recognized, got ${reordered}`);

        const unquoted = withContentSecurityPolicy('<head><meta http-equiv=Content-Security-Policy content="script-src *"></head>');
        assert.ok(!unquoted.includes('script-src *'), `expected an unquoted http-equiv value to still be recognized, got ${unquoted}`);
    });

    it('removes a <base> tag the report carries', () => {
        const html = '<html><head><base href="http://evil/"></head><body>hi</body></html>';
        const result = withContentSecurityPolicy(html);
        assert.ok(!result.toLowerCase().includes('<base'), `expected <base> to be removed, got ${result}`);
    });

    it("emits a policy with default-src 'none', frame-src 'none', form-action 'none' and base-uri 'none'", () => {
        assert.match(REPORT_CSP, /default-src 'none'/);
        assert.match(REPORT_CSP, /frame-src 'none'/);
        assert.match(REPORT_CSP, /form-action 'none'/);
        assert.match(REPORT_CSP, /base-uri 'none'/);
    });

    it('still allows the inline script and style the report needs to render its collapsible view', () => {
        assert.match(REPORT_CSP, /script-src 'unsafe-inline'/);
        assert.match(REPORT_CSP, /style-src 'unsafe-inline'/);
    });
});
