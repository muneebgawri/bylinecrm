import { appendFileSync } from 'node:fs';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { Check, Finding } from './checks';

/**
 * Prints the route gate's findings as one table at the end of the run: a row per route, a column
 * per width/theme, each cell the number of findings (✓ when none), then every finding in full.
 * On GitHub Actions the same table is written to the job summary.
 */
interface Row {
    url: string;
    primary: boolean;
    cells: Map<string, Finding[]>;
}

export default class RouteGateReporter implements Reporter {
    private readonly rows = new Map<string, Row>();
    private readonly projects = new Set<string>();

    onTestEnd(test: TestCase, result: TestResult): void {
        const project = test.parent.project()?.name ?? '?';
        this.projects.add(project);
        const annotation = test.annotations.find((a) => a.type === 'route-gate');
        const row = this.rows.get(test.title) ?? { url: '', primary: false, cells: new Map() };
        if (annotation?.description) {
            const data = JSON.parse(annotation.description) as { url: string; primary: boolean; findings: Finding[] };
            row.url = data.url;
            row.primary ||= data.primary;
            row.cells.set(project, data.findings);
        } else if (result.status !== 'passed') {
            // The state did not reach its checks (navigation, palette or settle failed).
            row.cells.set(project, [
                { check: 'axe', detail: `did not render: ${result.error?.message?.split('\n')[0] ?? result.status}` },
            ]);
        }
        this.rows.set(test.title, row);
    }

    onEnd(_result: FullResult): void {
        const projects = [...this.projects].sort();
        const header = ['route', 'ends at', 'primary action', ...projects];
        const lines = [
            `| ${header.join(' | ')} |`,
            `| ${header.map(() => '---').join(' | ')} |`,
            ...[...this.rows.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, row]) => {
                    const cells = projects.map((p) => {
                        const found = row.cells.get(p);
                        if (!found) return '–';
                        return found.length === 0 ? '✓' : String(found.length);
                    });
                    return `| ${name} | ${row.url || '–'} | ${row.primary ? 'yes' : 'none'} | ${cells.join(' | ')} |`;
                }),
        ];
        const details: string[] = [];
        const totals = new Map<Check, number>();
        for (const [name, row] of [...this.rows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            for (const [project, found] of row.cells) {
                for (const finding of found) {
                    totals.set(finding.check, (totals.get(finding.check) ?? 0) + 1);
                    details.push(`- ${name} @ ${project} — ${finding.check}: ${finding.detail}`);
                }
            }
        }
        const summary = totals.size
            ? `Findings: ${[...totals.entries()].map(([check, n]) => `${check} ${n}`).join(', ')}`
            : 'Findings: none';
        const text = ['', 'Route gate', '', ...lines, '', summary, ...details, ''].join('\n');
        process.stdout.write(text);
        const stepSummary = process.env.GITHUB_STEP_SUMMARY;
        if (stepSummary)
            appendFileSync(
                stepSummary,
                `## Route gate\n\n${lines.join('\n')}\n\n${summary}\n\n${details.join('\n')}\n`,
            );
    }
}
