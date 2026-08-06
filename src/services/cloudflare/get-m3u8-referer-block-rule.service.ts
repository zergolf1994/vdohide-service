import { DomainStatus } from '@/core/enums';
import { CustomDomainModel, SettingModel } from '@/db/models';
import { isIP } from 'node:net';

const BUILT_IN_ALLOWED_DOMAINS = ['localhost'];
const COUNTRY_CODE_SECOND_LEVEL_SUFFIXES = new Set([
    'ac',
    'co',
    'com',
    'edu',
    'go',
    'gov',
    'mil',
    'ne',
    'net',
    'or',
    'org',
    'sch',
]);

export const normalizeHostname = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    try {
        const rawValue = value.trim();
        const url = new URL(
            /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue)
                ? rawValue
                : `https://${rawValue}`
        );
        const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

        return hostname || null;
    } catch {
        return null;
    }
};

const getUniqueHostnames = (values: unknown[]): string[] => {
    return [...new Set(values.map(normalizeHostname).filter((value): value is string => Boolean(value)))]
        .sort((left, right) => left.localeCompare(right));
};

const getWildcardBaseDomain = (domain: string): string => {
    if (domain === 'localhost' || isIP(domain)) {
        return domain;
    }

    const labels = domain.split('.').filter(Boolean);
    if (labels.length <= 2) {
        return domain;
    }

    const topLevelDomain = labels.at(-1)!;
    const secondLevelLabel = labels.at(-2)!;
    const usesCountryCodeSecondLevelSuffix =
        topLevelDomain.length === 2 &&
        COUNTRY_CODE_SECOND_LEVEL_SUFFIXES.has(secondLevelLabel);

    return labels
        .slice(usesCountryCodeSecondLevelSuffix ? -3 : -2)
        .join('.');
};

const getLocalRefererWildcardPatterns = (domain: string): string[] => {
    if (domain === 'localhost' || isIP(domain)) {
        return [
            `http*://${domain}/*`,
            `http*://${domain}:*/*`,
        ];
    }

    return [];
};

const getRefererWildcardPatterns = (domains: string[]): string[] => {
    const patterns = new Set<string>();

    for (const domain of domains) {
        if (domain === 'localhost' || isIP(domain)) {
            for (const pattern of getLocalRefererWildcardPatterns(domain)) {
                patterns.add(pattern);
            }
            continue;
        }

        const baseDomain = getWildcardBaseDomain(domain);

        // A subdomain entry is covered by one base-domain wildcard.
        patterns.add(`http*://*.${baseDomain}/*`);

        // Only add the apex pattern when the apex itself is explicitly allowed.
        if (domain === baseDomain) {
            patterns.add(`http*://${baseDomain}/*`);
        }
    }

    return [...patterns].sort((left, right) => left.localeCompare(right));
};

export const buildRefererBlockCondition = (
    allowedDomains: string[],
    indent = ''
): string => {
    const allowConditions = getRefererWildcardPatterns(allowedDomains)
        .map((pattern) => `${indent}    http.referer wildcard "${pattern}"`)
        .join(' or\n');

    return [
        `${indent}(`,
        `${indent}  http.referer eq "" or`,
        `${indent}  not (`,
        allowConditions,
        `${indent}  )`,
        `${indent})`,
    ].join('\n');
};

export const getAllowedRefererDomains = async (): Promise<string[]> => {
    const [domainPreviewSetting, customDomains] = await Promise.all([
        SettingModel.findOne(
            { name: 'domain_preview' },
            { _id: 0, value: 1 }
        ).lean(),
        CustomDomainModel.find(
            {
                enable: true,
                status: DomainStatus.ACTIVE,
            },
            { _id: 0, name: 1 }
        )
            .sort({ name: 1 })
            .lean(),
    ]);

    return getUniqueHostnames([
        domainPreviewSetting?.value,
        ...customDomains.map((domain) => domain.name),
        ...BUILT_IN_ALLOWED_DOMAINS,
    ]);
};

export const buildM3u8RefererBlockRule = (
    requestHostname: string,
    allowedDomains: string[]
): string => {
    return [
        '(',
        `  lower(http.host) eq "${requestHostname}" and`,
        '  ends_with(http.request.uri.path, ".m3u8") and',
        buildRefererBlockCondition(allowedDomains, '  '),
        ')',
    ].join('\n');
};

export const getM3u8RefererBlockRule = async () => {
    const [domainPlaylistSetting, allowedDomains] = await Promise.all([
        SettingModel.findOne(
            { name: 'domain_playlist' },
            { _id: 0, value: 1 }
        ).lean(),
        getAllowedRefererDomains(),
    ]);

    const domainPlaylist = normalizeHostname(domainPlaylistSetting?.value);

    if (!domainPlaylist) {
        throw new Error('Setting "domain_playlist" is not configured');
    }

    return {
        requestHostname: domainPlaylist,
        allowedDomains,
        rule: buildM3u8RefererBlockRule(domainPlaylist, allowedDomains),
    };
};
