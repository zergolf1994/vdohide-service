export function randomString(length: number = 33, special: boolean = true): string {
    if (length <= 0) return '';

    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';

    for (let i = 0; i < length; i++) {
        result += characters[Math.floor(Math.random() * characters.length)];
    }

    if (special && length >= 3) {
        const insertAt = (str: string, index: number, char: string): string =>
            str.slice(0, index) + char + str.slice(index);

        const dashPos = Math.floor(Math.random() * (length - 2)) + 1;
        let underscorePos = Math.floor(Math.random() * (length - 2)) + 1;

        while (dashPos === underscorePos) {
            underscorePos = Math.floor(Math.random() * (length - 2)) + 1;
        }

        if (dashPos < underscorePos) {
            result = insertAt(result, dashPos, '-');
            result = insertAt(result, underscorePos + 1, '_');
        } else {
            result = insertAt(result, underscorePos, '_');
            result = insertAt(result, dashPos + 1, '-');
        }
    }

    return result;
}

export function randomStringWithPrefix(prefix: string = "A", length: number = 10): string {
    if (!prefix || length <= 0) return prefix || '';
    return `${prefix}-${randomString(length, false)}`;
}

export function randomDigits(length: number = 6): string {
    if (length <= 0) return '';
    if (length === 1) return Math.floor(Math.random() * 10).toString();
    if (length > 15) length = 15;

    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return Math.floor(min + Math.random() * (max - min + 1)).toString();
}

export function generateWalletNumber(): string {
    return randomDigits(12)
}