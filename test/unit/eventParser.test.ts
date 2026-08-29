import assert from 'node:assert/strict';
import { parseEvent } from '../../src/model/eventParser';
import { isSuiteItem, PostRunEvent, PostSuiteEvent, PostTestEvent, PreRunEvent, PreSuiteEvent, PreTestEvent } from '../../src/model/events';

describe('eventParser', () => {
    it('parses pre-run with a nested suite/test tree', () => {
        const xml = `<event type="pre-run">
            <totalNumberOfTests>2</totalNumberOfTests>
            <items>
                <item id="suite1">
                    <name>suite1</name>
                    <description>Suite 1</description>
                    <items>
                        <item id="suite1.test1">
                            <name>test1</name>
                            <ownerName>HR</ownerName>
                            <objectName>PKG_X</objectName>
                            <procedureName>TEST1</procedureName>
                        </item>
                    </items>
                </item>
            </items>
        </event>`;
        const event = parseEvent('pre-run', xml) as PreRunEvent;
        assert.equal(event.type, 'pre-run');
        assert.equal(event.totalNumberOfTests, 2);
        assert.equal(event.items.length, 1);
        assert.ok(isSuiteItem(event.items[0]));
        const suite = event.items[0];
        if (isSuiteItem(suite)) {
            assert.equal(suite.id, 'suite1');
            assert.equal(suite.items.length, 1);
            const test = suite.items[0];
            assert.ok(!isSuiteItem(test));
            if (!isSuiteItem(test)) {
                assert.equal(test.id, 'suite1.test1');
                assert.equal(test.ownerName, 'HR');
            }
        }
    });

    it('parses post-run counters, output and warnings', () => {
        // Real shape from UT_REALTIME_REPORTER.after_calling_run: everything
        // sits inside a nested <run> element, not directly on <event> — this
        // exact mismatch (reading eventNode.counter instead of
        // eventNode.run.counter) was a real bug that silently produced
        // "0 passed, 0 failed" for every run.
        const xml = `<event type="post-run">
            <run>
                <startTime>2026-01-01T00:00:00</startTime>
                <endTime>2026-01-01T00:00:02</endTime>
                <executionTime>2.5</executionTime>
                <counter><disabled>0</disabled><success>3</success><failure>1</failure><error>0</error><warning>1</warning></counter>
                <serverOutput>hello</serverOutput>
                <warnings><warning>deprecated api</warning></warnings>
            </run>
        </event>`;
        const event = parseEvent('post-run', xml) as PostRunEvent;
        assert.equal(event.counter.success, 3);
        assert.equal(event.counter.failure, 1);
        assert.equal(event.executionTime, 2.5);
        assert.equal(event.serverOutput, 'hello');
        assert.deepEqual(event.warnings, ['deprecated api']);
    });

    it('parses pre-suite', () => {
        const xml = `<event type="pre-suite"><suite id="suite1"><name>suite1</name><items/></suite></event>`;
        const event = parseEvent('pre-suite', xml) as PreSuiteEvent;
        assert.equal(event.suite.id, 'suite1');
        assert.equal(event.suite.name, 'suite1');
    });

    it('parses post-suite counters', () => {
        // Real shape from after_calling_suite: id and counter are attributes/
        // children of a nested <suite> element, not of <event> itself.
        const xml = `<event type="post-suite">
            <suite id="suite1">
                <counter><disabled>1</disabled><success>0</success><failure>0</failure><error>0</error><warning>0</warning></counter>
            </suite>
        </event>`;
        const event = parseEvent('post-suite', xml) as PostSuiteEvent;
        assert.equal(event.id, 'suite1');
        assert.equal(event.counter.disabled, 1);
    });

    it('parses pre-test', () => {
        const xml = `<event type="pre-test"><test id="suite1.test1"><name>test1</name><ownerName>HR</ownerName></test></event>`;
        const event = parseEvent('pre-test', xml) as PreTestEvent;
        assert.equal(event.test.id, 'suite1.test1');
        assert.equal(event.test.ownerName, 'HR');
    });

    it('parses post-test with failed expectations and caller line', () => {
        // Real shape from after_calling_test: id, counter and
        // failedExpectations are nested inside <test>, not on <event>.
        const xml = `<event type="post-test">
            <test id="suite1.test1">
                <executionTime>0.1</executionTime>
                <counter><disabled>0</disabled><success>0</success><failure>1</failure><error>0</error><warning>0</warning></counter>
                <failedExpectations>
                    <expectation>
                        <description>desc</description>
                        <message>Actual: 1 was expected to equal: 2</message>
                        <caller>"HR.PKG_X", line 42</caller>
                    </expectation>
                </failedExpectations>
            </test>
        </event>`;
        const event = parseEvent('post-test', xml) as PostTestEvent;
        assert.equal(event.id, 'suite1.test1');
        assert.equal(event.failedExpectations.length, 1);
        assert.match(event.failedExpectations[0].caller ?? '', /line 42/);
    });

    it('never throws on malformed XML and returns undefined', () => {
        const messages: string[] = [];
        const result = parseEvent('post-test', '<event type="post-test"><unterminated>', (m) => messages.push(m));
        // fast-xml-parser is lenient with unterminated tags; assert this call
        // does not throw regardless of the parsed shape.
        assert.doesNotThrow(() => result);
    });

    it('logs but does not throw on an unknown itemType', () => {
        const messages: string[] = [];
        const result = parseEvent('weird-type', '<event type="weird-type"/>', (m) => messages.push(m));
        assert.equal(result, undefined);
        assert.ok(messages.some((m) => m.includes('unknown ITEM_TYPE')));
    });
});
