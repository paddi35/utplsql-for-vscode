/**
 * Pure HTML string handling for the coverage HTML report (see
 * showHtmlReport() in coverage.ts), kept vscode-free so it can be unit
 * tested directly with plain mocha/tsx instead of the extension host —
 * same split as src/workspace/virtualSourcePath.ts and
 * src/db/reporterDao.ts's buildRunWithReporterSql, for the same reason:
 * coverage.ts imports 'vscode' at the top and therefore cannot be
 * `require()`d by plain mocha/tsx at all.
 *
 * Issue #13: ut_coverage_html_reporter's output is a self-contained report
 * assembled by the *database* from database-derived text — schema names,
 * object names, and verbatim package source lines — none of which
 * necessarily comes from the person who ends up viewing the report on a
 * shared schema. A crafted package name or source comment containing
 * `</script><script>...</script>` is passed through by utPLSQL completely
 * unescaped (see test/integration/coverage.test.ts's XSS-passthrough case),
 * so whatever renders this HTML has to assume it may be running
 * attacker-controlled script, not merely attacker-influenced text.
 *
 * REPORT_CSP/withContentSecurityPolicy() are one half of the containment
 * this issue asks for (the policy itself, and making sure it is the only
 * one in force); the other half is *where* the resulting HTML gets
 * rendered at all — see showHtmlReport()'s doc comment in coverage.ts for
 * why that no longer is an extension-host webview, and why this module's
 * policy still matters wherever it ends up being rendered instead.
 */

/**
 * default-src 'none' removes the obvious exfiltration channel: connect-src
 * is one of the "fetch directives" that fall back to default-src when not
 * set explicitly, so with no override there is nowhere for a fetch()/XHR/
 * WebSocket the report's script might issue to actually reach. script-src/
 * style-src stay 'unsafe-inline' because the report's own collapsible
 * file/line view is driven by its own inline <script>/<style> — with
 * scripts disabled the report opens but stays blank/inert, so inline code
 * has to stay allowed for the report to work at all. img-src data: is for
 * whatever inline icons/markers the report embeds as data URIs.
 *
 * frame-src/form-action/base-uri close the gaps default-src 'none' does not
 * already reach:
 *   - frame-src is technically already implied by default-src 'none' (it is
 *     itself one of the fetch directives that fall back to default-src per
 *     the CSP spec), but is spelled out here so that guarantee does not
 *     silently depend on every future rendering context implementing that
 *     fallback chain the same way.
 *   - form-action and base-uri are NOT fetch directives and get no such
 *     fallback from default-src at all. Left unset, an injected payload
 *     could still submit a `<form action="https://evil/...">` (with a
 *     script click()-ing it, or even without one — form-action also governs
 *     ordinary, script-free submission) or redirect every relative URL on
 *     the page via an injected `<base href="https://evil/">`, regardless of
 *     how restrictive default-src is.
 * Explicitly closing both is what turns "no network destination for
 * *script* to reach" into "no network destination for *anything on the
 * page* to reach."
 */
export const REPORT_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'; form-action 'none'; base-uri 'none';";

/**
 * Removes any `<meta http-equiv="Content-Security-Policy" ...>` the report
 * itself carries. withContentSecurityPolicy() is meant to be the *only*
 * authority on this document's policy: browsers apply every CSP meta tag
 * present at once (most-restrictive-wins per directive, not
 * first-or-last-tag-wins), so a competing tag left in place could not
 * actually *loosen* what we set — but it would mean the effective policy on
 * any directive we don't set ourselves silently depends on whatever the
 * report happened to declare, instead of being legible from REPORT_CSP
 * alone. Matched structurally — does this <meta>'s http-equiv attribute say
 * Content-Security-Policy, in whatever attribute order or quoting style —
 * rather than by one do-everything regex, so an unrelated
 * `<meta charset="utf-8">` or `<meta name="viewport" ...>` the report also
 * carries is never at risk of being swept up by it.
 */
function stripExistingCsp(html: string): string {
    return html.replace(/<meta\b[^>]*>/gi, (tag) => {
        const httpEquiv = /\bhttp-equiv\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/i.exec(tag);
        if (!httpEquiv) {
            return tag;
        }
        const value = (httpEquiv[2] ?? httpEquiv[3] ?? httpEquiv[4] ?? '').toLowerCase();
        return value === 'content-security-policy' ? '' : tag;
    });
}

/**
 * Removes any `<base ...>` the report itself carries. The report is fully
 * self-contained (no relative links or resources of its own), so there is
 * no legitimate case for it to declare one — left in place, a
 * `<base href="https://evil/">` could silently redirect any relative URL
 * anything on the page (a future version of the report, or the injected
 * payload itself) ever writes.
 */
function stripExistingBase(html: string): string {
    return html.replace(/<base\b[^>]*>/gi, '');
}

/**
 * Strips any competing policy/base tag the report carries (see
 * stripExistingCsp/stripExistingBase above) and inserts REPORT_CSP as the
 * one `<meta http-equiv="Content-Security-Policy">` in the document,
 * immediately after `<head>` when there is one. Reports observed against a
 * live utPLSQL 3.2.3 instance do have a `<head>`, but nothing guarantees
 * that, so a report with none gets the tag prepended instead — a CSP meta
 * tag outside `<head>` is invalid per spec, but every browser tested still
 * honours one that appears before any `<script>`/`<body>` content, and
 * prepending is the only way to guarantee "before" without a `<head>` to
 * anchor on.
 */
export function withContentSecurityPolicy(html: string): string {
    const sanitized = stripExistingBase(stripExistingCsp(html));
    const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
    const head = /<head[^>]*>/i.exec(sanitized);
    if (!head) {
        return meta + sanitized;
    }
    const insertAt = head.index + head[0].length;
    return sanitized.slice(0, insertAt) + meta + sanitized.slice(insertAt);
}
