#!/usr/bin/env node
/**
 * Every container image BylineCRM runs comes from its own GHCR mirror, pinned by digest (#123).
 *
 * Reads deploy/images/mirror.json (the one list of third-party images) and every file that names an
 * image — workflows, Dockerfiles, compose files — and fails when any of them:
 *   - names a public registry directly (public.ecr.aws, docker.io, …) or an unqualified image
 *     (`postgres:16`, which means Docker Hub), whose anonymous per-IP limits break CI;
 *   - names a mirror image by tag, or by a digest the list does not hold for that image;
 * and when a listed image is referenced nowhere (a dead mirror entry). Our own images
 * (`…/bylinecrm-api`, `…/bylinecrm-web`, built by images.yml) are exempt: they are not third-party.
 *
 * Exits 1 with one line per problem. `checkImageRefs` is exported for the test.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIST = 'deploy/images/mirror.json';
/** Files that may name an image. The list itself and the workflow that copies it name sources on purpose. */
const SCANNED =
    /(^|\/)(docker-compose[^/]*\.ya?ml|[^/]*\.?Dockerfile|Dockerfile[^/]*)$|^\.github\/workflows\/.*\.ya?ml$/;
const EXEMPT_FILES = new Set([LIST, '.github/workflows/mirror-images.yml']);
const OWN_IMAGE = /\/bylinecrm-(api|web)(:|@|$)/;
const PUBLIC_REGISTRY = /\b(public\.ecr\.aws|docker\.io|registry-1\.docker\.io|quay\.io|gcr\.io|mcr\.microsoft\.com)\b/;

/** Image references in one file's text: compose/workflow `image:`, Dockerfile `FROM` and `ARG *_IMAGE=`. */
export function imageRefs(text) {
    const refs = [];
    const patterns = [
        /^\s*image:\s*['"]?([^\s'"#]+)/gm,
        /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s#]+)/gim,
        /^\s*ARG\s+\w*IMAGE\w*=([^\s#]+)/gim,
    ];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const line = text.slice(0, match.index).split('\n').length;
            refs.push({ ref: match[1], line });
        }
    }
    return refs;
}

/**
 * @param {{ registry: string, images: { name: string, digest: string }[] }} list
 * @param {{ path: string, text: string }[]} files
 * @returns {string[]} problems, one line each
 */
export function checkImageRefs(list, files) {
    const problems = [];
    const byName = new Map(list.images.map((image) => [image.name, image]));
    const used = new Set();
    const stages = new Set();

    for (const { path, text } of files) {
        for (const match of text.matchAll(/^\s*FROM\s+\S+\s+AS\s+(\S+)/gim)) stages.add(match[1].toLowerCase());
        text.split('\n').forEach((content, index) => {
            if (PUBLIC_REGISTRY.test(content) && !content.trim().startsWith('#')) {
                problems.push(`${path}:${index + 1}: names a public registry — use ${list.registry}/<name>@<digest>`);
            }
        });
        for (const { ref, line } of imageRefs(text)) {
            const where = `${path}:${line}`;
            // An ARG/env expansion, a YAML alias (`image: *api-image`) or list (a matrix `image: [api, web]`), or our own image.
            if (/^[$*[]/.test(ref) || OWN_IMAGE.test(ref)) continue;
            if (stages.has(ref.toLowerCase())) continue; // FROM <earlier build stage>
            if (!ref.startsWith(`${list.registry}/`)) {
                if (!PUBLIC_REGISTRY.test(ref)) problems.push(`${where}: ${ref} is not from ${list.registry}`);
                continue;
            }
            const [named, digest] = ref.slice(list.registry.length + 1).split('@');
            const repository = named.replace(/:[^/]*$/, ''); // `postgres:16` names the postgres repository
            const image = byName.get(repository);
            if (!image) {
                problems.push(`${where}: ${repository} is not in ${LIST}`);
            } else if (!digest) {
                problems.push(`${where}: ${ref} is not pinned — use @${image.digest}`);
            } else if (digest !== image.digest) {
                problems.push(`${where}: ${repository}@${digest} — ${LIST} lists ${image.digest}`);
            } else {
                used.add(repository);
            }
        }
    }
    for (const image of list.images) {
        if (!used.has(image.name)) problems.push(`${LIST}: ${image.name} is referenced nowhere — remove it`);
    }
    return problems;
}

function main() {
    const list = JSON.parse(readFileSync(LIST, 'utf8'));
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
    const files = tracked
        .filter((path) => path && SCANNED.test(path) && !EXEMPT_FILES.has(path))
        .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    const problems = checkImageRefs(list, files);
    if (problems.length > 0) {
        for (const problem of problems) console.error(`check-image-refs: ${problem}`);
        process.exit(1);
    }
    console.log(`check-image-refs: ${files.length} files, every image from ${list.registry} by a listed digest`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
