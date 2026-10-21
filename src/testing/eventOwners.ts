import { SuiteItemInfo, TestItemInfo, isSuiteItem } from '../model/events';

type Node = SuiteItemInfo | TestItemInfo;

/** Owner of the first test below `node` (or of `node` itself, if it is a test). */
export function firstOwner(node: Node): string | undefined {
    if (!isSuiteItem(node)) {
        return node.ownerName?.toUpperCase();
    }
    for (const child of node.items) {
        const owner = firstOwner(child);
        if (owner) {
            return owner;
        }
    }
    return undefined;
}

/**
 * Resolves the owning schema of live reporter events. Suite and test events
 * carry only the suitepath, which is ambiguous when two schemas share one in
 * a single run — but the pre-run event lists every test with its ownerName
 * and testNumber, and tests then announce themselves by testNumber. Suites
 * have no number; they are streamed in pre-run tree order, so each suite id
 * keeps a queue of owners in that order.
 */
export class EventOwnerResolver {
    private readonly testOwners = new Map<number, string>();
    private readonly pendingSuites = new Map<string, Array<string | undefined>>();
    private readonly openSuites = new Map<string, Array<string | undefined>>();

    constructor(preRunItems: Node[]) {
        preRunItems.forEach((n) => this.walk(n));
    }

    ownerOfTest(testNumber: number | undefined): string | undefined {
        return testNumber === undefined ? undefined : this.testOwners.get(testNumber);
    }

    startSuite(id: string): string | undefined {
        const owner = this.pendingSuites.get(id)?.shift();
        push(this.openSuites, id, owner);
        return owner;
    }

    endSuite(id: string): string | undefined {
        return this.openSuites.get(id)?.shift();
    }

    private walk(node: Node): void {
        if (!isSuiteItem(node)) {
            if (node.testNumber !== undefined && node.ownerName) {
                this.testOwners.set(node.testNumber, node.ownerName.toUpperCase());
            }
            return;
        }
        push(this.pendingSuites, node.id, firstOwner(node));
        node.items.forEach((c) => this.walk(c));
    }
}

function push(map: Map<string, Array<string | undefined>>, key: string, value: string | undefined): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}
