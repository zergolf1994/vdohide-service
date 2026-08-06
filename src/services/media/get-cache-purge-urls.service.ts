import { MediaType } from '@/core/enums';
import { MediaModel } from '@/db/models';
import { getSetting } from '@/services/setting/get-setting.service';

export const CACHE_PURGE_STORAGE_ID = 'ecadd66e-4462-4d3c-853b-d9fa8f7d13f0';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 30;

interface GetCachePurgeUrlsOptions {
    page?: number;
    limit?: number;
}

const normalizeDomainPlaylist = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Setting "domain_playlist" is not configured');
    }

    const domain = value.trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
};

export const getCachePurgeUrls = async ({
    page = DEFAULT_PAGE,
    limit = DEFAULT_LIMIT,
}: GetCachePurgeUrlsOptions = {}) => {
    const domainPlaylist = normalizeDomainPlaylist(await getSetting('domain_playlist'));
    const normalizedPage = Math.max(Math.trunc(page), DEFAULT_PAGE);
    const normalizedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
    const offset = (normalizedPage - 1) * normalizedLimit;

    const filter: Record<string, unknown> = {
        storageId: CACHE_PURGE_STORAGE_ID,
        type: MediaType.VIDEO,
        slug: { $exists: true, $ne: '' },
    };

    const medias = (await MediaModel.find(filter)
        .select({ _id: 1, slug: 1 })
        .sort({ _id: 1 })
        .skip(offset)
        .limit(normalizedLimit + 1)
        .lean()) as Array<{ _id: string; slug: string }>;

    const hasMore = medias.length > normalizedLimit;
    const mediaPage = hasMore ? medias.slice(0, normalizedLimit) : medias;

    return {
        message: 'Success',
        data: {
            storageId: CACHE_PURGE_STORAGE_ID,
            domainPlaylist,
            page: normalizedPage,
            limit: normalizedLimit,
            count: mediaPage.length,
            hasMore,
            nextPage: hasMore ? normalizedPage + 1 : null,
            urls: mediaPage.map((media) => `${domainPlaylist}/${media.slug}/video.m3u8`),
        },
    };
};
