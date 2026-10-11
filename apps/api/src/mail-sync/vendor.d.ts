/**
 * Declarations for two small MIT libraries from the nodemailer project that ship no types. Only
 * what mail sync and sending call is declared.
 */
declare module 'addressparser' {
    function addressparser(value: string): addressparser.ParsedAddress[];
    namespace addressparser {
        interface ParsedAddress {
            name: string;
            address?: string;
            group?: ParsedAddress[];
        }
    }
    export = addressparser;
}

declare module 'libmime' {
    /** The library exports one instance; its methods use `this`, so call them on it. */
    const libmime: {
        /** Decodes RFC 2047 encoded-words in a header value (`=?UTF-8?B?…?=`). */
        decodeWords(value: string): string;
        /**
         * Encodes the non-ASCII runs of a header value as RFC 2047 encoded-words (`B` = base64),
         * each word at most `maxLength` characters; ASCII text is left as written.
         */
        encodeWords(value: string, mimeWordEncoding: 'B' | 'Q', maxLength?: number): string;
    };
    export = libmime;
}
