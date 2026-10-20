import type { MailAssetView } from '@bylinecrm/shared';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { WORKSPACE_PARAM } from '../routes/params';
import { request } from './client';
import { workspacePath } from './endpoints';

/** Images for mail (a composed email's or a template's body, or a signature), stored and served by the API. */
export const mailAssets = {
    upload: (workspaceId: string, file: File) => {
        const body = new FormData();
        body.append('file', file);
        return request<MailAssetView>('POST', workspacePath(workspaceId, '/mail-assets'), { body });
    },
};

/** Uploads an image into the current workspace; `undefined` outside one (nothing to upload into). */
export function useUploadMailImage(): ((file: File) => Promise<MailAssetView>) | undefined {
    const workspaceId = useParams()[WORKSPACE_PARAM];
    return useMemo(
        () => (workspaceId ? (file: File) => mailAssets.upload(workspaceId, file) : undefined),
        [workspaceId],
    );
}
