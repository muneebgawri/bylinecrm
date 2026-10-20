import type { MailAssetView, RichText, RichTextNode } from '@bylinecrm/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RichTextEditor, type RichTextProfile } from './RichTextEditor';

const EMPTY: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };
const ASSET: MailAssetView = {
    id: 'a1',
    url: 'https://crm.example.com/api/public/mail-assets/tok.png',
    width: 1200,
    height: 600,
    contentType: 'image/png',
    sizeBytes: 1000,
};

function find(doc: RichText | undefined, type: string): RichTextNode[] {
    const out: RichTextNode[] = [];
    const walk = (nodes: RichTextNode[] | undefined) =>
        nodes?.forEach((n) => {
            if (n.type === type) out.push(n);
            walk(n.content);
        });
    walk(doc?.content);
    return out;
}

function setup(profile: RichTextProfile, uploadImage = vi.fn(async () => ASSET)) {
    let last: RichText | undefined;
    const onChange = vi.fn((doc: RichText) => {
        last = doc;
    });
    render(
        <RichTextEditor
            profile={profile}
            aria-label="Body"
            value={EMPTY}
            onChange={onChange}
            uploadImage={uploadImage}
        />,
    );
    return { uploadImage, latest: () => last };
}

describe('the editor’s images and tables', () => {
    it('offers images and tables in a body, images only in a signature, neither in a note', async () => {
        const { unmount } = render(
            <RichTextEditor profile="template" aria-label="Body" value={EMPTY} onChange={() => undefined} />,
        );
        expect(await screen.findByRole('button', { name: 'Add image' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Insert table' })).toBeInTheDocument();
        unmount();
        const sig = render(
            <RichTextEditor profile="signature" aria-label="Sig" value={EMPTY} onChange={() => undefined} />,
        );
        expect(await screen.findByRole('button', { name: 'Add image' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Insert table' })).not.toBeInTheDocument();
        sig.unmount();
        render(<RichTextEditor profile="note" aria-label="Note" value={EMPTY} onChange={() => undefined} />);
        await screen.findByRole('textbox', { name: 'Note' });
        expect(screen.queryByRole('button', { name: 'Add image' })).not.toBeInTheDocument();
    });

    it('uploads a chosen image and puts it in by its public address, at most the column wide, alt text from its name', async () => {
        const { uploadImage, latest } = setup('template');
        const user = userEvent.setup();
        const file = new File([new Uint8Array([1, 2, 3])], 'Team photo.png', { type: 'image/png' });
        await user.upload(screen.getByLabelText('Image to add'), file);
        expect(uploadImage).toHaveBeenCalledWith(file);
        await waitFor(() => expect(find(latest(), 'image')).toHaveLength(1));
        expect(find(latest(), 'image')[0]!.attrs).toMatchObject({ src: ASSET.url, alt: 'Team photo', width: 600 });
    });

    it('refuses a file that is not a PNG or JPEG, or too big, before uploading', async () => {
        const { uploadImage } = setup('signature');
        const user = userEvent.setup({ applyAccept: false });
        await user.upload(
            screen.getByLabelText('Image to add'),
            new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }),
        );
        expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PNG or JPEG image.');
        await user.upload(
            screen.getByLabelText('Image to add'),
            new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' }),
        );
        expect(await screen.findByRole('alert')).toHaveTextContent('An image is at most 2 MB.');
        expect(uploadImage).not.toHaveBeenCalled();
    });

    it('says why an upload failed', async () => {
        setup(
            'template',
            vi.fn(async () => Promise.reject(new Error('offline'))),
        );
        const user = userEvent.setup();
        await user.upload(
            screen.getByLabelText('Image to add'),
            new File([new Uint8Array(3)], 'a.png', { type: 'image/png' }),
        );
        expect(await screen.findByRole('alert')).toHaveTextContent(/The image was not added/);
    });

    it('inserts a table with a header row, and adds and removes rows and columns from its bar', async () => {
        const { latest } = setup('template');
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Insert table' }));
        await waitFor(() => expect(find(latest(), 'table')).toHaveLength(1));
        expect(find(latest(), 'tableRow')).toHaveLength(3);
        expect(find(latest(), 'tableHeader')).toHaveLength(3);
        const bar = screen.getByRole('toolbar', { name: 'Table' });
        expect(bar).toBeInTheDocument();
        // A table never goes inside another.
        expect(screen.getByRole('button', { name: 'Insert table' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Add row' }));
        await waitFor(() => expect(find(latest(), 'tableRow')).toHaveLength(4));
        await user.click(screen.getByRole('button', { name: 'Add column' }));
        await waitFor(() => expect(find(latest(), 'tableHeader')).toHaveLength(4));
        await user.click(screen.getByRole('button', { name: 'Delete column' }));
        await waitFor(() => expect(find(latest(), 'tableHeader')).toHaveLength(3));
        await user.click(screen.getByRole('button', { name: 'Delete table' }));
        await waitFor(() => expect(find(latest(), 'table')).toHaveLength(0));
    });
});
