// #123: the image-reference gate. Run with `node --test scripts/check-image-refs.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkImageRefs } from './check-image-refs.mjs';

const D = 'sha256:' + 'a'.repeat(64);
const OTHER = 'sha256:' + 'b'.repeat(64);
const list = { registry: 'ghcr.io/acme/mirror', images: [{ name: 'postgres', digest: D }] };
const ok = { path: 'ci.yml', text: `services:\n  pg:\n    image: ghcr.io/acme/mirror/postgres@${D}\n` };

test('#123 accepts a mirror image pinned by its listed digest', () => {
    assert.deepEqual(checkImageRefs(list, [ok]), []);
});

test('#123 refuses a public registry, an unqualified image, a tag and an unlisted digest', () => {
    const problems = checkImageRefs(list, [
        ok,
        { path: 'a.yml', text: 'image: public.ecr.aws/docker/library/postgres:16\n' },
        { path: 'b.yml', text: 'image: postgres:16\n' },
        { path: 'c.yml', text: 'image: ghcr.io/acme/mirror/postgres:16\n' },
        { path: 'd.yml', text: `image: ghcr.io/acme/mirror/postgres@${OTHER}\n` },
        { path: 'e.yml', text: `image: ghcr.io/acme/mirror/redis@${D}\n` },
    ]);
    assert.equal(problems.length, 5, problems.join('\n'));
    assert.match(problems.join('\n'), /a\.yml:1: names a public registry/);
    assert.match(problems.join('\n'), /b\.yml:1: postgres:16 is not from/);
    assert.match(problems.join('\n'), /c\.yml:1: .* is not pinned/);
    assert.match(problems.join('\n'), /d\.yml:1: postgres@sha256:b+ — .* lists/);
    assert.match(problems.join('\n'), /e\.yml:1: redis is not in/);
});

test('#123 checks Dockerfile ARG defaults and FROM, but not build stages or ARG expansions', () => {
    const dockerfile = {
        path: 'api.Dockerfile',
        text: `ARG NODE_IMAGE=docker.io/library/node:22\nFROM \${NODE_IMAGE} AS base\nFROM base AS build\n`,
    };
    const problems = checkImageRefs(list, [ok, dockerfile]);
    assert.deepEqual(problems, ['api.Dockerfile:1: names a public registry — use ghcr.io/acme/mirror/<name>@<digest>']);
});

test('#123 exempts our own images and reports a listed image nobody uses', () => {
    const own = {
        path: 'compose.yml',
        text: 'image: ${PREFIX:-ghcr.io/acme}/bylinecrm-api:${SHA}\napi:\n  image: *api-image\nmatrix:\n  image: [api, web]\n',
    };
    assert.deepEqual(checkImageRefs(list, [own]), [
        'deploy/images/mirror.json: postgres is referenced nowhere — remove it',
    ]);
});
