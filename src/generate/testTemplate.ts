import * as vscode from 'vscode';
import { TestableUnit } from '../db/utplsqlDao';

export interface GenerateOptions {
    testPackagePrefix: string;
    testPackageSuffix: string;
    testUnitPrefix: string;
    testUnitSuffix: string;
    numberOfTestsPerUnit: number;
    generateComments: boolean;
    disableTests: boolean;
    suitePath: string;
    indentSpaces: number;
}

export function readGenerateOptions(): GenerateOptions {
    const cfg = vscode.workspace.getConfiguration('utplsql.generate');
    return {
        testPackagePrefix: cfg.get('testPackagePrefix', 'test_'),
        testPackageSuffix: cfg.get('testPackageSuffix', ''),
        testUnitPrefix: cfg.get('testUnitPrefix', ''),
        testUnitSuffix: cfg.get('testUnitSuffix', ''),
        numberOfTestsPerUnit: cfg.get('numberOfTestsPerUnit', 1),
        generateComments: cfg.get('generateComments', true),
        disableTests: cfg.get('disableTests', false),
        suitePath: cfg.get('suitePath', 'alltests'),
        indentSpaces: cfg.get('indentSpaces', 3)
    };
}

/** Port of oddgen/TestTemplate.java + TestGenerator.java: builds a test package skeleton. */
export function generateTestPackage(unit: TestableUnit, procedureNames: string[], options: GenerateOptions): string {
    const indent = ' '.repeat(options.indentSpaces);
    const pkgName = `${options.testPackagePrefix}${unit.objectName}${options.testPackageSuffix}`.toLowerCase();
    const units = procedureNames.length > 0 ? procedureNames : [unit.subobjectName ?? unit.objectName];

    const testNames: string[] = [];
    for (const unitName of units) {
        for (let i = 1; i <= Math.max(1, options.numberOfTestsPerUnit); i++) {
            const suffix = options.numberOfTestsPerUnit > 1 ? `_${i}` : '';
            testNames.push(`${options.testUnitPrefix}${unitName}${options.testUnitSuffix}${suffix}`.toLowerCase());
        }
    }

    const spec: string[] = [];
    spec.push(`CREATE OR REPLACE PACKAGE ${pkgName} IS`);
    spec.push('');
    spec.push(`${indent}--%suite(${unit.objectName})`);
    spec.push(`${indent}--%suitepath(${options.suitePath})`);
    spec.push('');
    for (let i = 0; i < testNames.length; i++) {
        const unitName = units[Math.floor(i / Math.max(1, options.numberOfTestsPerUnit))];
        if (options.generateComments) {
            spec.push(`${indent}--%test(Test ${unitName})`);
        }
        if (options.disableTests) {
            spec.push(`${indent}--%disabled`);
        }
        spec.push(`${indent}PROCEDURE ${testNames[i]};`);
        spec.push('');
    }
    spec.push(`END ${pkgName};`);
    spec.push('/');

    const body: string[] = [];
    body.push(`CREATE OR REPLACE PACKAGE BODY ${pkgName} IS`);
    body.push('');
    for (const testName of testNames) {
        body.push(`${indent}PROCEDURE ${testName} IS`);
        body.push(`${indent}BEGIN`);
        body.push(`${indent}${indent}ut.expect(1).to_equal(1);`);
        body.push(`${indent}END ${testName};`);
        body.push('');
    }
    body.push(`END ${pkgName};`);
    body.push('/');

    return `${spec.join('\n')}\n\n${body.join('\n')}\n`;
}
