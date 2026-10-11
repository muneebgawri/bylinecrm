import { envIssues } from '../config/env';

/**
 * `node dist/cli/check-env.js` — does this environment boot this build of the api? (#120)
 *
 * The staging release runs it in the NEW image, with the server's `staging.env`, before it migrates or
 * touches the running stack: a variable a release starts to require is reported here, the release
 * refuses, and the api already serving keeps serving. It reads the same schema as the api's boot, so
 * it refuses for exactly the reasons the api would. Exit 0 when the environment boots, 1 otherwise,
 * with one `VARIABLE: message` line per problem on stdout (stdout, so the release can tell them from
 * docker compose's own progress on stderr). It prints no value, only names.
 */
export function checkEnv(source: NodeJS.ProcessEnv, report: (line: string) => void): number {
    const issues = envIssues(source);
    for (const issue of issues) report(issue);
    return issues.length === 0 ? 0 : 1;
}

if (require.main === module) {
    process.exitCode = checkEnv(process.env, (line) => console.log(line));
}
