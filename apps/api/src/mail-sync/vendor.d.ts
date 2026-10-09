/**
 * Declarations for two small MIT libraries from the nodemailer project that ship no types. Only
 * what mail sync calls is declared.
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
    };
    export = libmime;
}
