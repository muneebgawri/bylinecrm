/**
 * The browser saves a file the page already holds (an export fetched through the API client, so a
 * refusal shows the API's words instead of a downloaded error page): a temporary link, clicked once.
 */
export function saveFile(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}
